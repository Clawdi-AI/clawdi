import { createHash } from "node:crypto";
import {
	chmodSync,
	chownSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { writePrivateFileAtomic } from "../lib/private-file";
import { runtimeContentSha256 } from "./applied-state";
import { applyEgressTransparentRuntimeEnv } from "./egress-env";
import type { RuntimeInstallReceiptEntry, RuntimeInstallReceipts } from "./install-receipts";
import type { RuntimeManifest } from "./manifest-contract";
import type { RuntimeMitmproxyEnsureResult } from "./mitmproxy-fetch";
import type { RuntimePaths } from "./paths";
import {
	type RuntimeName,
	type RuntimeRunConfig,
	type RuntimeServiceName,
	runtimeManagedBinDir,
	withoutPathEntry,
} from "./run-config";
import {
	daemonProgramRevision,
	runtimeServiceProgramRevision,
	runtimeSidecarProgramRevision,
} from "./runtime-impact-revision";
import {
	commandResolvable,
	ensureConfiguredRuntimeUserManagerReady,
	executableExists,
	makeRuntimeUserOwned,
	runningAsRoot,
	runRuntimeUserCommand,
	runtimeEgressGid,
	runtimeEgressUid,
	runtimeUserGid,
	runtimeUserUid,
	spawnRuntimeUserCommand,
	withRuntimeUserFileAccess,
} from "./runtime-user-command";
import { type RuntimeEnvironmentAuthority, runtimeSecretValue } from "./secret-values";
import {
	GENERATED_RUNTIME_SYSTEMD_FILE_HEADER,
	isGeneratedRuntimeSystemdFile,
} from "./systemd-user";

function systemdRevisionHash(value: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(canonicalSystemdRevisionValue(value)))
		.digest("hex")
		.slice(0, 32);
}

function canonicalSystemdRevisionValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalSystemdRevisionValue);
	if (value && typeof value === "object") {
		const input = value as Record<string, unknown>;
		return Object.fromEntries(
			Object.keys(input)
				.sort()
				.map((key) => [key, canonicalSystemdRevisionValue(input[key])]),
		);
	}
	return value;
}

function runtimeCommandPath(name: string, home: string): string | null {
	if (name === "openclaw") return join(home, ".openclaw", "bin", "openclaw");
	if (name === "hermes") return join(home, ".local", "bin", "hermes");
	return null;
}

function makeRootOwned(path: string): void {
	if (!runningAsRoot()) return;
	try {
		chownSync(path, 0, 0);
	} catch {
		/* Best effort outside hosted Linux. */
	}
}

function makeRootReadableDir(path: string): void {
	mkdirSync(path, { recursive: true });
	makeRootOwned(path);
	try {
		chmodSync(path, 0o755);
	} catch {
		/* Best effort outside POSIX. */
	}
}

export interface RuntimeSystemdUserProgram {
	runtime: RuntimeName;
	service: RuntimeServiceName | null;
	command: string;
	args: string[];
	cwd: string;
	env: Record<string, string>;
	resolvedSecretEnv: Record<string, string>;
}

export interface RuntimeEgressSystemdProgram {
	profileBundlePath: string;
	envFilePath: string;
	transparentPort: number;
	addonPath: string;
	addonSha256: string;
	engine: Extract<RuntimeMitmproxyEnsureResult, { status: "ready" }>;
	systemCaBundle: string;
	secretFilePath: string | null;
}

export interface RuntimeInstallReceiptTarget {
	desiredRevision: string;
	currentRevision: () => string | null;
	expectedCurrentRevision: string | null;
}

export interface OfficialRuntimeServicePlan {
	targets: Map<string, RuntimeInstallReceiptTarget>;
	pending: Array<{ program: RuntimeSystemdUserProgram; target: RuntimeInstallReceiptTarget }>;
}

interface RuntimeEgressIdentity {
	runtimeUid: number;
	runtimeGid: number;
	egressUid: number;
	egressGid: number;
}

function runtimeEgressSystemdProgram(
	manifest: RuntimeManifest,
	paths: RuntimePaths,
	profileBundlePath: string | null,
	secretFilePath: string | null,
	engine: RuntimeMitmproxyEnsureResult | null,
	addon: { path: string; sha256: string } | null,
): RuntimeEgressSystemdProgram | null {
	if (!profileBundlePath) return null;
	if (engine?.status !== "ready") return null;
	if (!addon) return null;
	const port = 18_080 + (hashToUInt16(`${manifest.instanceId}:${paths.serviceStateRoot}`) % 20_000);
	return {
		profileBundlePath,
		envFilePath: paths.egressTransparentEnv,
		transparentPort: port,
		addonPath: addon.path,
		addonSha256: addon.sha256,
		engine,
		systemCaBundle: paths.egressSystemCaFile,
		secretFilePath,
	};
}

export function resolveRuntimeSystemdIdentity(input: {
	manifest: RuntimeManifest;
	paths: RuntimePaths;
	profileBundlePath: string | null;
	secretFilePath: string | null;
	engine: RuntimeMitmproxyEnsureResult | null;
	addon: { path: string; sha256: string } | null;
	runtimeUser: string;
}): {
	egressProgram: RuntimeEgressSystemdProgram | null;
	identity: RuntimeEgressIdentity | null;
} {
	const egressProgram = runtimeEgressSystemdProgram(
		input.manifest,
		input.paths,
		input.profileBundlePath,
		input.secretFilePath,
		input.engine,
		input.addon,
	);
	if (!egressProgram) return { egressProgram: null, identity: null };
	return {
		egressProgram,
		identity: {
			runtimeUid: runtimeUserUid(input.runtimeUser),
			runtimeGid: runtimeUserGid(input.runtimeUser),
			egressUid: runtimeEgressUid(),
			egressGid: runtimeEgressGid(),
		},
	};
}

export function buildRuntimeSystemdUserProgram(input: {
	config: RuntimeRunConfig;
	paths: RuntimePaths;
	secretValues: Record<string, string> | undefined;
	runtimeEnvironment: RuntimeEnvironmentAuthority;
	egress: RuntimeEgressSystemdProgram | null;
}): RuntimeSystemdUserProgram | null {
	if (!input.config.enabled) return null;

	const currentPath = withoutPathEntry(
		withoutPathEntry(runtimeSystemdPath(input.paths), runtimeManagedBinDir(input.paths)),
		dirname(input.paths.cliManagedBin),
	);
	const pathPrefix = input.config.prependPath.join(":");
	const env: Record<string, string> = {
		...input.config.env,
		PATH: pathPrefix ? [pathPrefix, currentPath].filter(Boolean).join(":") : currentPath,
	};
	const resolvedSecretEnv: Record<string, string> = {};
	for (const [envName, ref] of Object.entries(input.config.secretEnv)) {
		const value = runtimeSecretValue(input.secretValues ?? {}, ref, input.runtimeEnvironment);
		if (!value) {
			throw new Error(`Runtime secret ${ref} for ${envName} is unavailable.`);
		}
		env[envName] = value;
		resolvedSecretEnv[envName] = value;
	}
	if (input.egress) {
		applyEgressTransparentRuntimeEnv(env, { caFile: input.egress.systemCaBundle });
	}

	const command =
		input.config.commandPath && existsSync(input.config.commandPath)
			? input.config.commandPath
			: input.config.command;

	return {
		runtime: input.config.runtime,
		service: input.config.service,
		command,
		args: input.config.defaultArgs,
		cwd: input.config.cwd ?? input.paths.workspaceRoot,
		env,
		resolvedSecretEnv,
	};
}

function hashToUInt16(input: string): number {
	return createHash("sha256").update(input).digest().readUInt16BE(0);
}

function runtimeSystemdProgramName(program: RuntimeSystemdUserProgram): string {
	const officialName = officialRuntimeSystemdProgramName(program);
	if (officialName) return officialName;
	if (!program.service) return `clawdi-${systemdUnitNameSegment(program.runtime)}`;
	return runtimeServiceProgramName(program.runtime, program.service);
}

function officialRuntimeSystemdProgramName(program: RuntimeSystemdUserProgram): string | null {
	return officialRuntimeServiceDescriptorForProgram(program)?.programName ?? null;
}

function runtimeSystemdProgramRevision(
	manifest: RuntimeManifest,
	program: RuntimeSystemdUserProgram,
	secretValues: Record<string, string> | undefined,
	runtimeEnvironment: RuntimeEnvironmentAuthority,
	providerProjectionRevisions: Partial<Record<string, string | null>> = {},
	runtimeRevision: (
		manifest: RuntimeManifest,
		runtime: string,
		secretValues: Record<string, string> | undefined,
		runtimeEnvironment: RuntimeEnvironmentAuthority,
		providerProjectionRevision: string | null,
	) => string,
): string {
	if (program.service) return runtimeServiceProgramRevision(program);
	return runtimeRevision(
		manifest,
		program.runtime,
		secretValues,
		runtimeEnvironment,
		providerProjectionRevisions[program.runtime] ?? null,
	);
}

function runtimeServiceProgramName(runtime: string, service: string): string {
	const official = OFFICIAL_RUNTIME_SERVICE_DESCRIPTORS.find(
		(descriptor) => descriptor.runtime === runtime && descriptor.service === service,
	);
	if (official) return official.programName;
	if (runtime === "hermes" && service === "dashboard") return "clawdi-hermes-dashboard";
	return `clawdi-${systemdUnitNameSegment(runtime)}-${systemdUnitNameSegment(service)}`;
}

function systemdUnitNameSegment(value: string): string {
	return value.replace(/[^A-Za-z0-9_-]+/g, "-");
}

function runtimeSystemdPath(paths: RuntimePaths): string {
	return [
		join(paths.serviceStateRoot, "bin"),
		join(paths.userHome, ".local", "bin"),
		join(paths.userHome, ".openclaw", "bin"),
		process.env.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
	].join(":");
}

function systemdUnitFileName(name: string): string {
	return `${systemdUnitNameSegment(name)}.service`;
}

function systemdDropInFilePath(paths: RuntimePaths, unitName: string): string {
	return join(paths.systemdUserRoot, `${systemdUnitFileName(unitName)}.d`, "10-clawdi-hosted.conf");
}

function systemdQuote(value: string): string {
	if (/[\r\n]/.test(value)) {
		throw new Error("systemd unit values must be single-line strings");
	}
	return `"${value
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/%/g, "%%")
		.replace(/\$/g, "$$")}"`;
}

function systemdExec(command: string, args: string[]): string {
	return [command, ...args].map(systemdQuote).join(" ");
}

function systemdPath(value: string): string {
	if (!isAbsolute(value)) {
		throw new Error(`systemd unit paths must be absolute: ${value}`);
	}
	if (/[\r\n]/.test(value)) {
		throw new Error("systemd unit paths must be single-line strings");
	}
	return value
		.replace(/\\/g, "\\\\")
		.replace(/%/g, "%%")
		.replace(/ /g, "\\x20")
		.replace(/\t/g, "\\x09");
}

function systemdUnitEnvironmentLines(values: Record<string, string>): string[] {
	return Object.entries(values).map(
		([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`,
	);
}

function systemdEnvironmentFilePath(paths: RuntimePaths, unitName: string): string {
	return join(paths.systemdEnvRoot, `${systemdUnitFileName(unitName)}.env`);
}

function systemdEnvironmentFileQuote(value: string): string {
	if (/[\r\n]/.test(value)) {
		throw new Error("systemd environment files only support single-line values");
	}
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

type OfficialRuntimeServiceDescriptor = {
	runtime: RuntimeName;
	programName: string;
	command: string;
	installArgs: string[];
	uninstallArgs: string[];
	// Manifest `services` key the official unit corresponds to; used for
	// program naming even when such an entry is not official for the runtime.
	service: string;
	// Extra env projected into the unit's environment file.
	unitEnv?: (unitName: string) => Record<string, string>;
	// Which desired programs the official unit covers. Deliberately
	// asymmetric: openclaw's default program is its gateway, while hermes may
	// express the gateway as the default program or an explicit
	// `services.gateway` entry.
	matchesProgram: (program: RuntimeSystemdUserProgram) => boolean;
};

const OFFICIAL_RUNTIME_SERVICE_DESCRIPTORS: OfficialRuntimeServiceDescriptor[] = [
	{
		runtime: "openclaw",
		programName: "openclaw-gateway",
		command: "openclaw",
		installArgs: ["gateway", "install", "--force", "--json"],
		uninstallArgs: ["gateway", "uninstall"],
		service: "gateway",
		unitEnv: (unitName) => ({ OPENCLAW_SYSTEMD_UNIT: unitName }),
		matchesProgram: (program) => !program.service,
	},
	{
		runtime: "hermes",
		programName: "hermes-gateway",
		command: "hermes",
		installArgs: ["gateway", "install", "--force"],
		uninstallArgs: ["gateway", "uninstall"],
		service: "gateway",
		matchesProgram: (program) => (program.service ?? program.args[0] ?? "") === "gateway",
	},
];

function officialRuntimeServiceDescriptorForProgram(
	program: RuntimeSystemdUserProgram,
): OfficialRuntimeServiceDescriptor | null {
	return (
		OFFICIAL_RUNTIME_SERVICE_DESCRIPTORS.find(
			(descriptor) => descriptor.runtime === program.runtime && descriptor.matchesProgram(program),
		) ?? null
	);
}

function officialRuntimeServiceDescriptorForUnit(
	unitName: string,
): OfficialRuntimeServiceDescriptor | null {
	return (
		OFFICIAL_RUNTIME_SERVICE_DESCRIPTORS.find(
			(descriptor) => systemdUnitFileName(descriptor.programName) === unitName,
		) ?? null
	);
}

function officialRuntimeServiceCommand(
	descriptor: OfficialRuntimeServiceDescriptor,
	paths: RuntimePaths,
): string {
	const commandPath = runtimeCommandPath(descriptor.runtime, paths.userHome);
	return commandPath && executableExists(commandPath) ? commandPath : descriptor.command;
}

function runtimeFileCurrentRevision(path: string): string | null {
	if (!isAbsolute(path)) return null;
	try {
		const linkStat = lstatSync(path);
		if (!linkStat.isFile() && !linkStat.isSymbolicLink()) return null;
		const fileStat = linkStat.isSymbolicLink() ? statSync(path) : linkStat;
		if (!fileStat.isFile()) return null;
		const contents = readFileSync(path);
		return runtimeContentSha256({
			path,
			contentsSha256: createHash("sha256").update(contents).digest("hex"),
			kind: linkStat.isSymbolicLink() ? "symlink" : "file",
			linkTarget: linkStat.isSymbolicLink() ? readlinkSync(path) : null,
			linkUid: linkStat.uid,
			linkGid: linkStat.gid,
			fileMode: fileStat.mode & 0o7777,
			fileUid: fileStat.uid,
			fileGid: fileStat.gid,
		});
	} catch {
		return null;
	}
}

function runtimeCommandCurrentRevision(command: string, home: string, cwd: string): string | null {
	const executableRevision = runtimeFileCurrentRevision(command);
	if (!executableRevision) return null;
	try {
		const result = spawnRuntimeUserCommand(command, ["--version"], home, cwd);
		if (result.status !== 0) return null;
		const stdout = Buffer.isBuffer(result.stdout) ? result.stdout.toString("utf8") : result.stdout;
		const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8") : result.stderr;
		const version = [stdout, stderr].filter(Boolean).join("\n").trim();
		return version ? runtimeContentSha256({ executableRevision, version }) : null;
	} catch {
		return null;
	}
}

function officialServiceCurrentRevision(
	program: RuntimeSystemdUserProgram,
	paths: RuntimePaths,
): string | null {
	const descriptor = officialRuntimeServiceDescriptorForProgram(program);
	if (!descriptor) return null;
	const unitName = systemdUnitFileName(descriptor.programName);
	const unitPath = join(paths.systemdUserRoot, unitName);
	try {
		const contents = readFileSync(unitPath);
		if (isGeneratedRuntimeSystemdFile(contents.toString("utf8"))) return null;
		const unitStat = lstatSync(unitPath);
		if (!unitStat.isFile()) return null;
		const commandRevision = runtimeCommandCurrentRevision(
			officialRuntimeServiceCommand(descriptor, paths),
			paths.userHome,
			paths.userHome,
		);
		if (!commandRevision) return null;
		return runtimeContentSha256({
			commandRevision,
			programName: descriptor.programName,
			unitName,
			unitSha256: createHash("sha256").update(contents).digest("hex"),
			unitMode: unitStat.mode & 0o7777,
			unitUid: unitStat.uid,
			unitGid: unitStat.gid,
		});
	} catch {
		return null;
	}
}

function officialServiceDesiredRevision(program: RuntimeSystemdUserProgram): string {
	const descriptor = officialRuntimeServiceDescriptorForProgram(program);
	if (!descriptor) throw new Error("official service receipt requires an official service program");
	return runtimeContentSha256({
		runtime: descriptor.runtime,
		programName: descriptor.programName,
		serviceIdentity: descriptor.service,
		installerCommand: descriptor.command,
		installArgs: descriptor.installArgs,
	});
}

function verifiedReceiptCurrentRevision(
	receipt: RuntimeInstallReceiptEntry | undefined,
	desiredRevision: string,
	currentRevision: () => string | null,
): string | null {
	if (!receipt || receipt.desiredRevision !== desiredRevision) return null;
	const current = currentRevision();
	return current === receipt.currentRevision ? current : null;
}

export function planOfficialRuntimeServices(
	programs: RuntimeSystemdUserProgram[],
	paths: RuntimePaths,
	receipts: RuntimeInstallReceipts | null,
): OfficialRuntimeServicePlan {
	const targets = new Map<string, RuntimeInstallReceiptTarget>();
	const pending: OfficialRuntimeServicePlan["pending"] = [];
	if (!shouldInstallOfficialRuntimeServices()) return { targets, pending };
	for (const program of officialRuntimeSystemdPrograms(programs)) {
		const key = systemdUnitFileName(runtimeSystemdProgramName(program));
		const desiredRevision = officialServiceDesiredRevision(program);
		const currentRevision = () => officialServiceCurrentRevision(program, paths);
		const expectedCurrentRevision = verifiedReceiptCurrentRevision(
			receipts?.officialServices[key],
			desiredRevision,
			currentRevision,
		);
		const target = { desiredRevision, currentRevision, expectedCurrentRevision };
		targets.set(key, target);
		if (expectedCurrentRevision === null) pending.push({ program, target });
	}
	return { targets, pending };
}

function writeSystemdEnvironmentFile(input: {
	paths: RuntimePaths;
	name: string;
	owner: "root" | "runtime-user";
	env: Record<string, string>;
}): string {
	makeRootReadableDir(dirname(input.paths.systemdEnvRoot));
	makeRootReadableDir(input.paths.systemdEnvRoot);
	const path = systemdEnvironmentFilePath(input.paths, input.name);
	const lines = Object.entries(input.env)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, value]) => {
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
				throw new Error(`invalid systemd environment key: ${key}`);
			}
			return `${key}=${systemdEnvironmentFileQuote(value)}`;
		});
	writePrivateFileAtomic(path, `${GENERATED_RUNTIME_SYSTEMD_FILE_HEADER}\n${lines.join("\n")}\n`, {
		mode: 0o600,
		dirMode: 0o755,
	});
	if (input.owner === "runtime-user") makeRuntimeUserOwned(path);
	else makeRootOwned(path);
	return path;
}

function writeSystemdProgramEnvironment(input: {
	paths: RuntimePaths;
	name: string;
	owner: "root" | "runtime-user";
	env: Record<string, string>;
	revisionEnv?: Record<string, string>;
}): { envFile: string; envRevision: string } {
	return {
		envFile: writeSystemdEnvironmentFile(input),
		envRevision: systemdRevisionHash({
			systemdEnvironmentFile: "v1",
			env: input.revisionEnv ?? input.env,
		}),
	};
}

function writeSystemdUnit(input: {
	root: string;
	owner: "root" | "runtime-user";
	paths: RuntimePaths;
	name: string;
	description: string;
	command: string;
	args: string[];
	cwd: string;
	env: Record<string, string>;
	revisionEnv?: Record<string, string>;
	unitEnv?: Record<string, string>;
	serviceType?: "simple" | "oneshot" | "notify";
	restart?: boolean;
	extraUnitLines?: string[];
	extraServiceLines?: string[];
	wantedBy: "multi-user.target" | "default.target";
}): string {
	const path = join(input.root, systemdUnitFileName(input.name));
	const { envFile, envRevision } = writeSystemdProgramEnvironment({
		paths: input.paths,
		name: input.name,
		owner: input.owner,
		env: input.env,
		revisionEnv: input.revisionEnv,
	});
	const lines = [
		GENERATED_RUNTIME_SYSTEMD_FILE_HEADER,
		"[Unit]",
		`Description=${input.description}`,
		...(input.owner === "runtime-user"
			? [
					"# The environment file is regenerated by convergence each boot; this unit must not start before it exists.",
					`ConditionPathExists=${systemdPath(envFile)}`,
				]
			: []),
		...(input.extraUnitLines ?? []),
		"",
		"[Service]",
		`# ClawdiEnvironmentRevision=${envRevision}`,
		`Type=${input.serviceType ?? "simple"}`,
		`WorkingDirectory=${systemdPath(input.cwd)}`,
		...(input.unitEnv ? systemdUnitEnvironmentLines(input.unitEnv) : []),
		...(input.extraServiceLines ?? []),
		`EnvironmentFile=${systemdPath(envFile)}`,
		`ExecStart=${systemdExec(input.command, input.args)}`,
		...(input.restart === false
			? []
			: ["Restart=always", "RestartSec=2", "KillMode=mixed", "TimeoutStopSec=30"]),
		"",
		"[Install]",
		`WantedBy=${input.wantedBy}`,
		"",
	];
	const writeUnitFile = (): string => {
		mkdirSync(input.root, { recursive: true });
		if (input.owner === "runtime-user") makeRuntimeUserOwned(input.root);
		writePrivateFileAtomic(path, `${lines.join("\n")}`, { mode: 0o644, dirMode: 0o755 });
		if (input.owner === "runtime-user") makeRuntimeUserOwned(path);
		else makeRootOwned(path);
		return path;
	};
	return input.owner === "runtime-user"
		? withRuntimeUserFileAccess(writeUnitFile)
		: writeUnitFile();
}

function writeSystemdSystemUnit(
	input: Omit<Parameters<typeof writeSystemdUnit>[0], "root" | "owner" | "wantedBy">,
): string {
	return writeSystemdUnit({
		...input,
		root: input.paths.systemdSystemRoot,
		owner: "root",
		wantedBy: "multi-user.target",
	});
}

function writeSystemdUserUnit(
	input: Omit<Parameters<typeof writeSystemdUnit>[0], "root" | "owner" | "wantedBy">,
): string {
	return writeSystemdUnit({
		...input,
		root: input.paths.systemdUserRoot,
		owner: "runtime-user",
		extraServiceLines: [
			'Environment="XDG_RUNTIME_DIR=%t"',
			'Environment="DBUS_SESSION_BUS_ADDRESS=unix:path=%t/bus"',
			...(input.extraServiceLines ?? []),
		],
		wantedBy: "default.target",
	});
}

function writeSystemdUserDropIn(input: {
	paths: RuntimePaths;
	name: string;
	command: string;
	args: string[];
	cwd: string;
	env: Record<string, string>;
}): string {
	const unitName = systemdUnitFileName(input.name);
	const { envFile, envRevision } = writeSystemdProgramEnvironment({
		paths: input.paths,
		name: input.name,
		owner: "runtime-user",
		env: input.env,
	});
	const path = systemdDropInFilePath(input.paths, input.name);
	const lines = [
		GENERATED_RUNTIME_SYSTEMD_FILE_HEADER,
		"# ClawdiHostedRuntimeDropIn=v1",
		"# The base unit is generated by the runtime's official service installer.",
		"[Unit]",
		"# The environment file is regenerated by convergence each boot; this unit must not start before it exists.",
		`ConditionPathExists=${systemdPath(envFile)}`,
		"",
		"[Service]",
		`# ClawdiEnvironmentRevision=${envRevision}`,
		`WorkingDirectory=${systemdPath(input.cwd)}`,
		'Environment="XDG_RUNTIME_DIR=%t"',
		'Environment="DBUS_SESSION_BUS_ADDRESS=unix:path=%t/bus"',
		`EnvironmentFile=${systemdPath(envFile)}`,
		"ExecStart=",
		`ExecStart=${systemdExec(input.command, input.args)}`,
		"",
	];
	return withRuntimeUserFileAccess(() => {
		removeGeneratedRuntimeBaseUnit(input.paths, unitName);
		mkdirSync(dirname(path), { recursive: true });
		makeRuntimeUserOwned(dirname(path));
		writePrivateFileAtomic(path, `${lines.join("\n")}`, { mode: 0o644, dirMode: 0o755 });
		makeRuntimeUserOwned(path);
		return join(input.paths.systemdUserRoot, unitName);
	});
}

function removeGeneratedRuntimeBaseUnit(paths: RuntimePaths, unitName: string): void {
	const path = join(paths.systemdUserRoot, unitName);
	if (!isGeneratedSystemdFile(path)) return;
	rmSync(path, { force: true });
}

function officialRuntimeServiceInstallArgs(program: RuntimeSystemdUserProgram): string[] | null {
	return officialRuntimeServiceDescriptorForProgram(program)?.installArgs ?? null;
}

function shouldInstallOfficialRuntimeServices(): boolean {
	// Official gateway installers need a live systemd user bus to converge.
	// When the systemd apply phase is explicitly disabled (headless CI and
	// smoke containers without systemd), fall back to writing complete
	// clawdi-* units instead of failing the whole convergence; the next
	// convergence under real systemd retries the official install.
	const applyOverride = process.env.CLAWDI_SYSTEMD_APPLY?.trim().toLowerCase();
	if (applyOverride === "0" || applyOverride === "false") return false;
	const override = process.env.CLAWDI_RUNTIME_INSTALL_OFFICIAL_SERVICES?.trim().toLowerCase();
	if (override === "1" || override === "true") return true;
	if (override === "0" || override === "false") return false;
	return runningAsRoot();
}

function installOfficialRuntimeUserService(
	program: RuntimeSystemdUserProgram,
	paths: RuntimePaths,
): string | null {
	const descriptor = officialRuntimeServiceDescriptorForProgram(program);
	if (!descriptor || !shouldInstallOfficialRuntimeServices()) return null;
	const args = descriptor.installArgs;
	if (!commandResolvable(program.command)) {
		return `official ${runtimeSystemdProgramName(program)} service installer command is unavailable: ${program.command}`;
	}
	try {
		ensureConfiguredRuntimeUserManagerReady();
		resetFailedRuntimeUserService(runtimeSystemdProgramName(program), paths, program.cwd);
		runRuntimeUserCommand(program.command, args, "", paths.userHome, program.cwd);
		return null;
	} catch (error) {
		return `official ${runtimeSystemdProgramName(program)} service install failed: ${
			error instanceof Error ? error.message : String(error)
		}`;
	}
}

export function installOfficialRuntimeService(
	item: OfficialRuntimeServicePlan["pending"][number],
	paths: RuntimePaths,
): string | null {
	reloadRuntimeUserManager(paths, paths.userHome);
	const error = installOfficialRuntimeUserService({ ...item.program, cwd: paths.userHome }, paths);
	if (!error) item.target.expectedCurrentRevision = item.target.currentRevision();
	return error;
}

function resetFailedRuntimeUserService(name: string, paths: RuntimePaths, cwd: string): void {
	try {
		runRuntimeUserCommand(
			process.env.CLAWDI_SYSTEMCTL_PATH?.trim() || "systemctl",
			["--user", "reset-failed", systemdUnitFileName(name)],
			"",
			paths.userHome,
			cwd,
		);
	} catch {
		// The unit may not exist yet; reset-failed must never block convergence.
	}
}

function reloadRuntimeUserManager(paths: RuntimePaths, cwd: string): void {
	try {
		ensureConfiguredRuntimeUserManagerReady();
		runRuntimeUserCommand(
			process.env.CLAWDI_SYSTEMCTL_PATH?.trim() || "systemctl",
			["--user", "daemon-reload"],
			"",
			paths.userHome,
			cwd,
		);
	} catch {
		// Best-effort: environments without a reachable user manager (unit tests,
		// non-hosted hosts) must not fail convergence, and official installers
		// perform their own daemon-reload after writing the base unit.
	}
}

function uninstallOfficialRuntimeUserService(input: {
	unitName: string;
	paths: RuntimePaths;
	workspaceRoot: string;
}): string | null {
	const descriptor = officialRuntimeServiceDescriptorForUnit(input.unitName);
	if (!descriptor || !shouldInstallOfficialRuntimeServices()) return null;
	const command = officialRuntimeServiceCommand(descriptor, input.paths);
	if (!commandResolvable(command)) {
		return `official ${input.unitName} uninstaller command is unavailable: ${command}`;
	}
	try {
		ensureConfiguredRuntimeUserManagerReady();
		runRuntimeUserCommand(
			command,
			descriptor.uninstallArgs,
			"",
			input.paths.userHome,
			input.workspaceRoot,
		);
		return null;
	} catch (error) {
		return `official ${input.unitName} uninstall failed: ${
			error instanceof Error ? error.message : String(error)
		}`;
	}
}

function systemdUnitNameFromPath(unitPath: string): string {
	return unitPath.split("/").at(-1) ?? "";
}

function staleOfficialRuntimeUserServices(paths: RuntimePaths, writtenUnits: string[]): string[] {
	if (!existsSync(paths.systemdUserRoot)) return [];
	const writtenNames = new Set(writtenUnits.map(systemdUnitNameFromPath));
	const stale: string[] = [];
	for (const entry of readdirSync(paths.systemdUserRoot)) {
		if (!entry.endsWith(".service.d")) continue;
		const unitName = entry.slice(0, -".d".length);
		if (writtenNames.has(unitName)) continue;
		if (!officialRuntimeServiceDescriptorForUnit(unitName)) continue;
		const dropInPath = join(paths.systemdUserRoot, entry, "10-clawdi-hosted.conf");
		if (!isGeneratedSystemdFile(dropInPath)) continue;
		const baseUnitPath = join(paths.systemdUserRoot, unitName);
		if (!existsSync(baseUnitPath) || isGeneratedSystemdFile(baseUnitPath)) continue;
		stale.push(unitName);
	}
	return stale.sort();
}

export function removeStaleOfficialRuntimeServices(input: {
	paths: RuntimePaths;
	programs: RuntimeSystemdUserProgram[];
	workspaceRoot: string;
}): string[] {
	const errors: string[] = [];
	const writtenUnits = input.programs.map((program) =>
		join(input.paths.systemdUserRoot, systemdUnitFileName(runtimeSystemdProgramName(program))),
	);
	for (const unitName of staleOfficialRuntimeUserServices(input.paths, writtenUnits)) {
		const error = uninstallOfficialRuntimeUserService({
			unitName,
			paths: input.paths,
			workspaceRoot: input.workspaceRoot,
		});
		if (error) errors.push(error);
	}
	return errors;
}

function removeStaleSystemdUserUnits(paths: RuntimePaths, writtenUnits: string[]): void {
	withRuntimeUserFileAccess(() => {
		if (!existsSync(paths.systemdUserRoot)) return;
		const writtenNames = new Set(writtenUnits.map(systemdUnitNameFromPath));
		for (const entry of readdirSync(paths.systemdUserRoot)) {
			if (!entry.endsWith(".service")) continue;
			const path = join(paths.systemdUserRoot, entry);
			if (!entry.startsWith("clawdi-") && !isGeneratedSystemdFile(path)) continue;
			if (writtenNames.has(entry)) continue;
			rmSync(path, { force: true });
		}
		const wantsDir = join(paths.systemdUserRoot, "default.target.wants");
		if (existsSync(wantsDir)) {
			for (const entry of readdirSync(wantsDir)) {
				if (!entry.endsWith(".service")) continue;
				const unitPath = join(paths.systemdUserRoot, entry);
				if (!entry.startsWith("clawdi-") && !isGeneratedSystemdFile(unitPath)) continue;
				if (writtenNames.has(entry)) continue;
				rmSync(join(wantsDir, entry), { force: true });
			}
		}
		for (const entry of readdirSync(paths.systemdUserRoot)) {
			if (!entry.endsWith(".service.d")) continue;
			const unitName = entry.slice(0, -".d".length);
			const dropInPath = join(paths.systemdUserRoot, entry, "10-clawdi-hosted.conf");
			if (!isGeneratedSystemdFile(dropInPath)) continue;
			if (writtenNames.has(unitName)) continue;
			rmSync(dropInPath, { force: true });
			try {
				if (readdirSync(dirname(dropInPath)).length === 0)
					rmSync(dirname(dropInPath), { force: true });
			} catch {
				// Best effort cleanup only.
			}
		}
	});
}

function isGeneratedSystemdFile(path: string): boolean {
	try {
		return isGeneratedRuntimeSystemdFile(readFileSync(path, "utf-8"));
	} catch {
		return false;
	}
}

function removeStaleSystemdSystemUnits(paths: RuntimePaths, writtenUnits: string[]): void {
	if (!existsSync(paths.systemdSystemRoot)) return;
	const managed = new Set([
		"clawdi-runtime-watch.service",
		"clawdi-daemon.service",
		"clawdi-runtime-sidecar.service",
	]);
	const writtenNames = new Set(writtenUnits.map(systemdUnitNameFromPath));
	for (const entry of readdirSync(paths.systemdSystemRoot)) {
		if (!managed.has(entry) || writtenNames.has(entry)) continue;
		rmSync(join(paths.systemdSystemRoot, entry), { force: true });
	}
}

function removeStaleSystemdEnvironmentFiles(paths: RuntimePaths, writtenUnits: string[]): void {
	if (!existsSync(paths.systemdEnvRoot)) return;
	const writtenNames = new Set(writtenUnits.map((unit) => `${systemdUnitNameFromPath(unit)}.env`));
	for (const entry of readdirSync(paths.systemdEnvRoot)) {
		if (!entry.endsWith(".service.env")) continue;
		const path = join(paths.systemdEnvRoot, entry);
		if (!entry.startsWith("clawdi-") && !isGeneratedSystemdFile(path)) continue;
		if (writtenNames.has(entry)) continue;
		rmSync(path, { force: true });
	}
}

function runtimeManifestUrlEnv(
	sourcePath: string,
	secretValues: Record<string, string> | undefined,
	runtimeEnvironment: RuntimeEnvironmentAuthority,
): string {
	if (/^https?:\/\//i.test(sourcePath)) return sourcePath;
	return (
		runtimeSecretValue(
			secretValues ?? {},
			"env://CLAWDI_RUNTIME_MANIFEST_URL",
			runtimeEnvironment,
		) ?? ""
	);
}

export function runtimeSystemdCommonEnvironment(
	sourcePath: string,
	paths: RuntimePaths,
	secretValues: Record<string, string> | undefined,
	runtimeEnvironment: RuntimeEnvironmentAuthority,
): Record<string, string> {
	const runtimeUser =
		runtimeSecretValue(secretValues ?? {}, "env://CLAWDI_RUNTIME_USER", runtimeEnvironment) ??
		"clawdi";
	const environment: Record<string, string> = {
		HOME: paths.userHome,
		CLAWDI_RUNTIME_MODE:
			runtimeSecretValue(secretValues ?? {}, "env://CLAWDI_RUNTIME_MODE", runtimeEnvironment) ??
			"hosted",
		CLAWDI_RUNTIME_AUTH_ENV:
			runtimeSecretValue(secretValues ?? {}, "env://CLAWDI_RUNTIME_AUTH_ENV", runtimeEnvironment) ??
			"",
		CLAWDI_RUNTIME_USER: runtimeUser,
		CLAWDI_SERVICE_STATE_DIR: paths.serviceStateRoot,
		CLAWDI_RUN_DIR: paths.runRoot,
		CLAWDI_RUNTIME_MANIFEST_URL: runtimeManifestUrlEnv(
			sourcePath,
			secretValues,
			runtimeEnvironment,
		),
		PATH: runtimeSystemdPath(paths),
	};
	return environment;
}

function runtimeWatchSecretEnvironment(
	programs: RuntimeSystemdUserProgram[],
): Record<string, string> {
	const retained = new Map<string, { value: string; program: string }>();
	for (const program of [...programs].sort((a, b) =>
		runtimeSystemdProgramName(a).localeCompare(runtimeSystemdProgramName(b)),
	)) {
		const programName = runtimeSystemdProgramName(program);
		for (const [envName, value] of Object.entries(program.resolvedSecretEnv).sort(([a], [b]) =>
			a.localeCompare(b),
		)) {
			const existing = retained.get(envName);
			if (existing && existing.value !== value) {
				throw new Error(
					`Runtime watch secret environment ${envName} conflicts between ${existing.program} and ${programName}.`,
				);
			}
			retained.set(envName, { value, program: existing?.program ?? programName });
		}
	}
	return Object.fromEntries([...retained].map(([envName, entry]) => [envName, entry.value]));
}

function writeRuntimeSystemdUserProgram(input: {
	program: RuntimeSystemdUserProgram;
	commonEnvironment: Record<string, string>;
	manifest: RuntimeManifest;
	paths: RuntimePaths;
	secretValues: Record<string, string> | undefined;
	runtimeEnvironment: RuntimeEnvironmentAuthority;
	providerProjectionRevisions: Partial<Record<string, string | null>>;
	runtimeRevision: Parameters<typeof runtimeSystemdProgramRevision>[5];
}): string {
	const { program } = input;
	const name = runtimeSystemdProgramName(program);
	const unitName = systemdUnitFileName(name);
	const env = {
		...input.commonEnvironment,
		...program.env,
		...(input.manifest.locale ? { TZ: input.manifest.locale.timezone } : {}),
		CLAWDI_AUTH_TOKEN: "",
		CLAWDI_RUNTIME_REV: runtimeSystemdProgramRevision(
			input.manifest,
			program,
			input.secretValues,
			input.runtimeEnvironment,
			input.providerProjectionRevisions,
			input.runtimeRevision,
		),
		...(officialRuntimeServiceDescriptorForProgram(program)?.unitEnv?.(unitName) ?? {}),
	};
	if (officialRuntimeServiceInstallArgs(program)) {
		return writeSystemdUserDropIn({
			paths: input.paths,
			name,
			command: program.command,
			args: program.args,
			cwd: program.cwd,
			env,
		});
	}
	return writeSystemdUserUnit({
		paths: input.paths,
		name,
		description: `Clawdi hosted ${program.runtime}${program.service ? ` ${program.service}` : ""}`,
		command: program.command,
		args: program.args,
		cwd: program.cwd,
		env,
	});
}

function officialRuntimeSystemdPrograms(
	programs: RuntimeSystemdUserProgram[],
): RuntimeSystemdUserProgram[] {
	const byServiceName = new Map<string, RuntimeSystemdUserProgram>();
	for (const program of programs) {
		const serviceName = officialRuntimeSystemdProgramName(program);
		if (serviceName) byServiceName.set(serviceName, program);
	}
	return [...byServiceName.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([, program]) => program);
}

export function writeRuntimeSystemdState(
	runtimePrograms: RuntimeSystemdUserProgram[],
	egressProgram: RuntimeEgressSystemdProgram | null,
	egressIdentity: RuntimeEgressIdentity | null,
	manifest: RuntimeManifest,
	paths: RuntimePaths,
	workspaceRoot: string,
	daemonAuthTokenFile: string | null,
	secretValues: Record<string, string> | undefined,
	runtimeEnvironment: RuntimeEnvironmentAuthority,
	providerProjectionRevisions: Partial<Record<string, string | null>>,
	runtimeRevision: Parameters<typeof runtimeSystemdProgramRevision>[5],
	commonEnvironment: Record<string, string>,
): { systemUnits: string[]; userUnits: string[]; egressSidecarActive: boolean } {
	const runtimeUser = commonEnvironment.CLAWDI_RUNTIME_USER?.trim() || "clawdi";
	const systemUnits: string[] = [];
	const shouldRunEgress = egressProgram !== null && runtimePrograms.length > 0;
	const activeEgressProgram = shouldRunEgress ? egressProgram : null;
	const activeEgressIdentity = shouldRunEgress ? egressIdentity : null;
	const userUnits: string[] = [];
	const runtimeUid = shouldRunEgress ? runtimeUserUid(runtimeUser) : null;
	if (daemonAuthTokenFile) {
		const watchSecretEnvironment = runtimeWatchSecretEnvironment(runtimePrograms);
		systemUnits.push(
			writeSystemdSystemUnit({
				paths,
				name: "clawdi-runtime-watch",
				description: "Clawdi hosted runtime desired-state watcher",
				command: paths.cliManagedBin,
				args: ["runtime", "watch"],
				cwd: workspaceRoot,
				env: {
					...commonEnvironment,
					...watchSecretEnvironment,
					CLAWDI_AUTH_TOKEN: "",
				},
				// Unit files are 0644. Hash only secret destination names into their
				// revision so the unit cannot become an offline verifier for values.
				// The watcher resolves values from the atomic apply-context file on
				// each tick; keep secret bytes out of its public revision material.
				revisionEnv: {
					...commonEnvironment,
					...Object.fromEntries(Object.keys(watchSecretEnvironment).map((name) => [name, ""])),
					CLAWDI_AUTH_TOKEN: "",
				},
			}),
		);
	}

	if (daemonAuthTokenFile) {
		systemUnits.push(
			writeSystemdSystemUnit({
				paths,
				name: "clawdi-daemon",
				description: "Clawdi hosted runtime daemon",
				command: paths.cliManagedBin,
				args: ["daemon", "run", "--auth-token-file", daemonAuthTokenFile],
				cwd: workspaceRoot,
				env: {
					...commonEnvironment,
					CLAWDI_ENVIRONMENT_ID: manifest.environmentId,
					CLAWDI_SERVE_MODE: "container",
					CLAWDI_API_URL: manifest.controlPlane.apiUrl,
					CLAWDI_NO_AUTO_UPDATE: "1",
					CLAWDI_NO_UPDATE_CHECK: "1",
					CLAWDI_RUNTIME_REV: daemonProgramRevision(manifest),
				},
			}),
		);
	}

	if (activeEgressProgram) {
		systemUnits.push(
			writeSystemdSystemUnit({
				paths,
				name: "clawdi-runtime-sidecar",
				description: "Clawdi hosted runtime sidecar",
				command: paths.cliManagedBin,
				args: ["runtime", "sidecar"],
				cwd: workspaceRoot,
				env: {
					...commonEnvironment,
					CLAWDI_AUTH_TOKEN: "",
					CLAWDI_EGRESS_ENV_FILE: activeEgressProgram.envFilePath,
					CLAWDI_RUNTIME_REV: runtimeSidecarProgramRevision(
						manifest,
						activeEgressProgram,
						activeEgressIdentity,
					),
				},
				serviceType: "notify",
				extraUnitLines: runtimeUid === null ? undefined : [`Before=user@${runtimeUid}.service`],
				extraServiceLines: ["NotifyAccess=main"],
			}),
		);
	}

	for (const program of runtimePrograms) {
		userUnits.push(
			writeRuntimeSystemdUserProgram({
				program,
				commonEnvironment,
				manifest,
				paths,
				secretValues,
				runtimeEnvironment,
				providerProjectionRevisions,
				runtimeRevision,
			}),
		);
	}

	removeStaleSystemdSystemUnits(paths, systemUnits);
	removeStaleSystemdUserUnits(paths, userUnits);
	removeStaleSystemdEnvironmentFiles(paths, [...systemUnits, ...userUnits]);
	return { systemUnits, userUnits, egressSidecarActive: shouldRunEgress };
}

export function validateRuntimeSystemdPlan(programs: RuntimeSystemdUserProgram[]): void {
	for (const program of programs) {
		systemdUnitFileName(runtimeSystemdProgramName(program));
		systemdPath(program.cwd);
		systemdExec(program.command, program.args);
		for (const [key, value] of Object.entries(program.env)) {
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
				throw new Error(`invalid systemd environment key: ${key}`);
			}
			systemdEnvironmentFileQuote(value);
		}
	}
}
