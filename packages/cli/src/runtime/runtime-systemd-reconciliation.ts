import { createHash } from "node:crypto";
import {
	chmodSync,
	chownSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmdirSync,
	rmSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { writePrivateFileAtomic } from "../lib/private-file";
import { ensureDirectoryWithinTrustedRoot } from "../lib/trusted-directory";
import { applyEgressTransparentRuntimeEnv } from "./egress-env";
import type { RuntimeManifest } from "./manifest-contract";
import {
	runtimeCommandCurrentRevision,
	runtimeCommandPath,
	runtimeFileCurrentRevision,
	writeRuntimeInstallerLog,
} from "./manifest-install";
import type { RuntimeMitmproxyEnsureResult } from "./mitmproxy-fetch";
import {
	DEFAULT_RUN_ROOT,
	DEFAULT_SERVICE_STATE_ROOT,
	type RuntimePaths,
	SYSTEMD_FILE_BROWSER_STATE_DIRECTORY,
	SYSTEMD_PLATFORM_DIRECTORY,
} from "./paths";
import {
	type RuntimeName,
	type RuntimeRunConfig,
	type RuntimeServiceName,
	withoutPathEntry,
} from "./run-config";
import {
	daemonProgramRevision,
	runtimeImpactRevision,
	runtimeServiceProgramRevision,
	runtimeSidecarProgramRevision,
} from "./runtime-impact-revision";
import {
	commandResolvable,
	executableExists,
	makeRuntimeUserOwned,
	runningAsRoot,
	runRuntimeUserCommand,
	runtimeEgressGid,
	runtimeEgressUid,
	spawnRuntimeUserCommand,
	withRuntimeUserFileAccess,
} from "./runtime-user-command";
import { runtimeSecretValue } from "./secret-values";
import {
	isGeneratedRuntimeSystemdPath,
	managedRuntimeSystemdUnitEntries,
	RUNTIME_SYSTEMD_DROP_IN_FILE,
} from "./systemd";
import {
	GENERATED_RUNTIME_SYSTEMD_FILE_HEADER,
	isGeneratedRuntimeSystemdFile,
} from "./systemd-user";
import { TRANSPARENT_EGRESS_PORT } from "./transparent-egress";

export interface RuntimeSystemdUserProgram {
	programKind: "runtime" | "file-browser";
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

export interface OfficialRuntimeServicePlan {
	pending: Array<{
		unitName: string;
		program: RuntimeSystemdUserProgram;
		serviceRevision: string | null;
	}>;
	serviceRevisions: Record<string, string>;
}

export interface RuntimeSystemdStaleFilePlan {
	platformFiles: string[];
	userFiles: string[];
	systemUnits: string[];
	userUnits: string[];
}

interface RuntimeEgressIdentity {
	runtimeUid: number;
	runtimeGid: number;
	egressUid: number;
	egressGid: number;
}

function runtimeEgressSystemdProgram(
	paths: RuntimePaths,
	profileBundlePath: string | null,
	secretFilePath: string | null,
	engine: RuntimeMitmproxyEnsureResult | null,
	addon: { path: string; sha256: string } | null,
): RuntimeEgressSystemdProgram | null {
	if (!profileBundlePath) return null;
	if (engine?.status !== "ready") return null;
	if (!addon) return null;
	return {
		profileBundlePath,
		envFilePath: paths.egressTransparentEnv,
		transparentPort: TRANSPARENT_EGRESS_PORT,
		addonPath: addon.path,
		addonSha256: addon.sha256,
		engine,
		systemCaBundle: paths.egressSystemCaFile,
		secretFilePath,
	};
}

export function resolveRuntimeSystemdIdentity(input: {
	paths: RuntimePaths;
	profileBundlePath: string | null;
	secretFilePath: string | null;
	engine: RuntimeMitmproxyEnsureResult | null;
	addon: { path: string; sha256: string } | null;
	runtimeIdentity: { uid: number; gid: number };
}): {
	egressProgram: RuntimeEgressSystemdProgram | null;
	identity: RuntimeEgressIdentity | null;
} {
	const egressProgram = runtimeEgressSystemdProgram(
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
			runtimeUid: input.runtimeIdentity.uid,
			runtimeGid: input.runtimeIdentity.gid,
			egressUid: runtimeEgressUid(),
			egressGid: runtimeEgressGid(),
		},
	};
}

export function buildRuntimeSystemdUserProgram(input: {
	config: RuntimeRunConfig;
	paths: RuntimePaths;
	secretValues: Record<string, string> | undefined;
	egress: RuntimeEgressSystemdProgram | null;
}): RuntimeSystemdUserProgram | null {
	if (!input.config.enabled) return null;

	const currentPath = withoutPathEntry(
		runtimeSystemdPath(input.paths),
		dirname(input.paths.cliManagedBin),
	);
	const pathPrefix = input.config.prependPath.join(":");
	const env: Record<string, string> = {
		...input.config.env,
		PATH: pathPrefix ? [pathPrefix, currentPath].filter(Boolean).join(":") : currentPath,
	};
	const resolvedSecretEnv: Record<string, string> = {};
	for (const [envName, ref] of Object.entries(input.config.secretEnv)) {
		const value = runtimeSecretValue(input.secretValues ?? {}, ref);
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
		programKind: "runtime",
		runtime: input.config.runtime,
		service: input.config.service,
		command,
		args: input.config.defaultArgs,
		cwd: input.config.cwd ?? input.paths.workspaceRoot,
		env,
		resolvedSecretEnv,
	};
}

function runtimeSystemdProgramName(program: RuntimeSystemdUserProgram): string {
	if (program.programKind === "file-browser") return "clawdi-files";
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
	providerProjectionRevisions: Partial<Record<string, string | null>> = {},
	runtimeRevision: (
		manifest: RuntimeManifest,
		runtime: string,
		secretValues: Record<string, string> | undefined,
		providerProjectionRevision: string | null,
	) => string,
): string {
	if (program.programKind === "file-browser") {
		return runtimeImpactRevision({
			companion: manifest.companions?.filebrowser ?? null,
			providerProjectionRevision: null,
		});
	}
	if (program.service) return runtimeServiceProgramRevision(program);
	return runtimeRevision(
		manifest,
		program.runtime,
		secretValues,
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
		paths.userLocalBin,
		join(paths.userHome, ".openclaw", "bin"),
		process.env.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
	].join(":");
}

function systemdUnitFileName(name: string): string {
	return `${systemdUnitNameSegment(name)}.service`;
}

export function runtimeSystemdUserUnitName(program: RuntimeSystemdUserProgram): string {
	return systemdUnitFileName(runtimeSystemdProgramName(program));
}

function systemdDropInFilePath(paths: RuntimePaths, unitName: string): string {
	return join(
		paths.systemdUserRoot,
		`${systemdUnitFileName(unitName)}.d`,
		RUNTIME_SYSTEMD_DROP_IN_FILE,
	);
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

function fileBrowserSystemdExec(command: string, config: string): string {
	return systemdExec(command, ["-c", config]);
}

function fileBrowserVersionProbeExec(command: string, version: string, commit: string): string {
	const script =
		'output=$("$1" version 2>&1) || exit $?; case "$output" in *"$2"*) ;; *) exit 65 ;; esac; case "$output" in *"$3"*) ;; *) exit 65 ;; esac';
	return systemdExec("/bin/sh", ["-c", script, "sh", command, version, commit.slice(0, 7)]);
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

export function systemdEnvironmentFilePath(paths: RuntimePaths, unitName: string): string {
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
	// Resolved in memory for the installer subprocess; strict native auth may omit it from the unit.
	installSecretEnv?: readonly string[];
	// Manifest `services` key the official unit corresponds to; used for
	// program naming even when such an entry is not official for the runtime.
	service: string;
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
		installSecretEnv: ["OPENCLAW_GATEWAY_TOKEN"],
		service: "gateway",
		matchesProgram: (program) => !program.service,
	},
	{
		runtime: "hermes",
		programName: "hermes-gateway",
		command: "hermes",
		installArgs: ["gateway", "install", "--force", "--no-start-now"],
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

function officialRuntimeServiceRevision(
	program: RuntimeSystemdUserProgram,
	paths: RuntimePaths,
): string | null {
	const descriptor = officialRuntimeServiceDescriptorForProgram(program);
	if (!descriptor) return null;
	const unitName = systemdUnitFileName(descriptor.programName);
	const unitPath = join(paths.systemdUserRoot, unitName);
	let contents: Buffer;
	try {
		const unitStat = lstatSync(unitPath);
		if (!unitStat.isFile()) throw new Error(`official ${unitName} unit is not a regular file`);
		contents = readFileSync(unitPath);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
		throw error;
	}
	if (isGeneratedRuntimeSystemdFile(contents.toString("utf8"))) return null;
	const command = officialRuntimeServiceCommand(descriptor, paths);
	const commandRevision =
		descriptor.runtime === "hermes"
			? runtimeFileCurrentRevision(command)
			: runtimeCommandCurrentRevision(command, paths.userHome, paths.userHome);
	// An unavailable observation is not evidence that a valid service needs reinstalling.
	if (!commandRevision) {
		throw new Error(
			`official ${unitName} command revision is unavailable; refusing service reinstall`,
		);
	}
	return createHash("sha256").update(commandRevision).update("\0").update(contents).digest("hex");
}

export function planOfficialRuntimeServices(
	programs: RuntimeSystemdUserProgram[],
	paths: RuntimePaths,
	executeInstallers: boolean,
): OfficialRuntimeServicePlan {
	const pending: OfficialRuntimeServicePlan["pending"] = [];
	const serviceRevisions: Record<string, string> = {};
	if (!executeInstallers) return { pending, serviceRevisions };
	for (const program of officialRuntimeSystemdPrograms(programs)) {
		const unitName = systemdUnitFileName(runtimeSystemdProgramName(program));
		const serviceRevision = officialRuntimeServiceRevision(program, paths);
		if (serviceRevision) serviceRevisions[unitName] = serviceRevision;
		// Native updaters own service refresh. Fingerprint drift alone is not a repair request.
		if (!serviceRevision) {
			pending.push({ unitName, program, serviceRevision });
		}
	}
	return { pending, serviceRevisions };
}

const OFFICIAL_SERVICE_INSTALL_TIMEOUT_MS = 600_000;
const OFFICIAL_SERVICE_UNINSTALL_TIMEOUT_MS = 120_000;
const HERMES_DASHBOARD_INSTALL_TIMEOUT_MS = 600_000;
const HERMES_DASHBOARD_BUILD_TIMEOUT_MS = 900_000;
export const HERMES_DASHBOARD_BUILD_REVISION_FILE = ".clawdi-runtime-revision";

function writeSystemdEnvironmentFile(input: {
	paths: RuntimePaths;
	name: string;
	owner: "root" | "runtime-user";
	env: Record<string, string>;
}): string {
	ensureDirectoryWithinTrustedRoot(input.paths.runRoot, input.paths.systemdRuntimeRoot, {
		mode: 0o711,
	});
	chmodSync(input.paths.systemdRuntimeRoot, 0o711);
	ensureDirectoryWithinTrustedRoot(input.paths.runRoot, input.paths.systemdEnvRoot, {
		mode: 0o711,
	});
	// This is a deliberate handoff directory: tenant-owned 0600 environment
	// files must be traversable without making sibling platform files readable.
	chmodSync(input.paths.systemdEnvRoot, 0o711);
	const path = systemdEnvironmentFilePath(input.paths, input.name);
	const lines = Object.entries(input.env)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, value]) => {
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
				throw new Error(`invalid systemd environment key: ${key}`);
			}
			return `${key}=${systemdEnvironmentFileQuote(value)}`;
		});
	const content = `${GENERATED_RUNTIME_SYSTEMD_FILE_HEADER}\n${lines.join("\n")}\n`;
	writeSystemdManagedFile({
		path,
		content,
		mode: 0o600,
		dirMode: 0o711,
		trustedRoot: input.paths.runRoot,
		owner: input.owner,
	});
	return path;
}

function writeSystemdManagedFile(input: {
	path: string;
	content: string;
	mode: number;
	dirMode: number;
	trustedRoot: string;
	owner: "root" | "runtime-user";
}): void {
	let unchanged = false;
	try {
		const current = lstatSync(input.path);
		unchanged =
			current.isFile() && current.nlink === 1 && readFileSync(input.path, "utf8") === input.content;
	} catch {
		// A missing or unreadable target is replaced by the trusted atomic writer below.
	}
	if (unchanged) chmodSync(input.path, input.mode);
	else {
		writePrivateFileAtomic(input.path, input.content, {
			mode: input.mode,
			dirMode: input.dirMode,
			trustedRoot: input.trustedRoot,
		});
	}
	if (input.owner === "runtime-user") makeRuntimeUserOwned(input.path);
	else if (runningAsRoot()) chownSync(input.path, 0, 0);
}

function writeSystemdProgramEnvironment(input: {
	paths: RuntimePaths;
	name: string;
	owner: "root" | "runtime-user";
	env: Record<string, string>;
}): string {
	return writeSystemdEnvironmentFile(input);
}

function withRuntimeUserSystemdFiles<T>(
	operation: () => T & (T extends PromiseLike<unknown> ? never : unknown),
): T {
	return withRuntimeUserFileAccess(operation);
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
	unitEnv?: Record<string, string>;
	execStart?: string;
	serviceType?: "simple" | "oneshot" | "notify";
	restart?: boolean;
	directoryKind?: "platform" | "file-browser";
	extraUnitLines?: string[];
	extraServiceLines?: string[];
	unsetEnvironment?: readonly string[];
	wantedBy: "multi-user.target" | "default.target";
}): string {
	const path = join(input.root, systemdUnitFileName(input.name));
	const envFile = writeSystemdProgramEnvironment({
		paths: input.paths,
		name: input.name,
		owner: input.owner,
		env: input.env,
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
		`Type=${input.serviceType ?? "simple"}`,
		`WorkingDirectory=${systemdPath(input.cwd)}`,
		...(input.directoryKind === "platform"
			? [
					`ConfigurationDirectory=${SYSTEMD_PLATFORM_DIRECTORY}`,
					"ConfigurationDirectoryMode=0700",
					`StateDirectory=${SYSTEMD_PLATFORM_DIRECTORY}`,
					"StateDirectoryMode=0700",
					`CacheDirectory=${SYSTEMD_PLATFORM_DIRECTORY}`,
					"CacheDirectoryMode=0700",
					// Runtime state is prepared before convergence: the boot prep unit owns
					// the production root for the entire boot, while ensureRuntimeStateDirs()
					// creates non-default roots. Do not bind the shared root to this service.
				]
			: input.directoryKind === "file-browser"
				? [
						`StateDirectory=${SYSTEMD_FILE_BROWSER_STATE_DIRECTORY}`,
						"StateDirectoryMode=0700",
						`RuntimeDirectory=${SYSTEMD_FILE_BROWSER_STATE_DIRECTORY}`,
						"RuntimeDirectoryMode=0700",
					]
				: []),
		...(input.unitEnv ? systemdUnitEnvironmentLines(input.unitEnv) : []),
		...(input.unsetEnvironment?.length
			? [`UnsetEnvironment=${input.unsetEnvironment.join(" ")}`]
			: []),
		...(input.extraServiceLines ?? []),
		`EnvironmentFile=${systemdPath(envFile)}`,
		`ExecStart=${input.execStart ?? systemdExec(input.command, input.args)}`,
		...(input.restart === false
			? []
			: ["Restart=always", "RestartSec=2", "KillMode=mixed", "TimeoutStopSec=30"]),
		"",
		"[Install]",
		`WantedBy=${input.wantedBy}`,
		"",
	];
	const writeUnitFile = (): string => {
		if (input.owner === "runtime-user") mkdirSync(input.root, { recursive: true });
		ensureDirectoryWithinTrustedRoot(input.root, input.root);
		writeSystemdManagedFile({
			path,
			content: lines.join("\n"),
			mode: 0o644,
			dirMode: 0o755,
			trustedRoot: input.root,
			owner: input.owner,
		});
		return path;
	};
	return input.owner === "runtime-user"
		? withRuntimeUserSystemdFiles(writeUnitFile)
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
		wantedBy: "default.target",
	});
}

function writeSystemdUserEnvironmentDropIn(input: {
	paths: RuntimePaths;
	name: string;
	env: Record<string, string>;
	unsetEnvironment?: readonly string[];
}): string {
	const unitName = systemdUnitFileName(input.name);
	const envFile = writeSystemdProgramEnvironment({
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
		...(input.unsetEnvironment?.length
			? [`UnsetEnvironment=${input.unsetEnvironment.join(" ")}`]
			: []),
		`EnvironmentFile=${systemdPath(envFile)}`,
		"",
	];
	withRuntimeUserSystemdFiles(() => {
		removeGeneratedRuntimeBaseUnit(input.paths, unitName);
		mkdirSync(input.paths.systemdUserRoot, { recursive: true });
		ensureDirectoryWithinTrustedRoot(input.paths.systemdUserRoot, dirname(path));
		writeSystemdManagedFile({
			path,
			content: lines.join("\n"),
			mode: 0o644,
			dirMode: 0o755,
			trustedRoot: input.paths.systemdUserRoot,
			owner: "runtime-user",
		});
	});
	return join(input.paths.systemdUserRoot, unitName);
}

function removeSystemdUserEnvironmentDropIn(paths: RuntimePaths, name: string): void {
	const path = systemdDropInFilePath(paths, name);
	withRuntimeUserSystemdFiles(() => {
		rmSync(path, { force: true });
		if (existsSync(dirname(path)) && readdirSync(dirname(path)).length === 0) {
			rmdirSync(dirname(path));
		}
	});
}

function removeGeneratedRuntimeBaseUnit(paths: RuntimePaths, unitName: string): void {
	const path = join(paths.systemdUserRoot, unitName);
	if (!isGeneratedRuntimeSystemdPath(path)) return;
	rmSync(path, { force: true });
}

function officialRuntimeServiceInstallArgs(program: RuntimeSystemdUserProgram): string[] | null {
	return officialRuntimeServiceDescriptorForProgram(program)?.installArgs ?? null;
}

const OFFICIAL_INSTALLER_MAX_BUFFER_BYTES = 64 * 1024;

export function prepareOfficialRuntimeServiceDependencies(
	programs: RuntimeSystemdUserProgram[],
	plan: OfficialRuntimeServicePlan,
	paths: RuntimePaths,
	egressSystemCaFile?: string,
): string | null {
	// Hermes includes the dashboard's node_modules/.bin in its gateway unit.
	// Finish the cold build first so gateway startup cannot rewrite the installed unit.
	const preparesHermesGateway = plan.pending.some((item) => item.program.runtime === "hermes");
	const hasHermesDashboard = programs.some(
		(program) => program.runtime === "hermes" && program.service === "dashboard",
	);
	if (!preparesHermesGateway || !hasHermesDashboard) return null;

	const appRoot = join(paths.userHome, ".hermes", "hermes-agent");
	const index = join(appRoot, "hermes_cli", "web_dist", "index.html");
	const revisionFile = join(dirname(index), HERMES_DASHBOARD_BUILD_REVISION_FILE);
	const descriptor = OFFICIAL_RUNTIME_SERVICE_DESCRIPTORS.find(
		(candidate) => candidate.runtime === "hermes" && candidate.service === "gateway",
	);
	const commandRevision = descriptor
		? runtimeCommandCurrentRevision(
				officialRuntimeServiceCommand(descriptor, paths),
				paths.userHome,
				paths.userHome,
			)
		: null;
	if (
		commandRevision &&
		existsSync(index) &&
		existsSync(revisionFile) &&
		readFileSync(revisionFile, "utf8").trim() === commandRevision
	) {
		return null;
	}
	const commands = [
		{
			args: ["ci", "--include=dev", "--workspace", "web"],
			cwd: appRoot,
			timeoutMs: HERMES_DASHBOARD_INSTALL_TIMEOUT_MS,
		},
		{
			args: ["run", "build"],
			cwd: join(appRoot, "web"),
			timeoutMs: HERMES_DASHBOARD_BUILD_TIMEOUT_MS,
		},
	] as const;
	for (const command of commands) {
		let result: ReturnType<typeof spawnRuntimeUserCommand>;
		try {
			result = spawnRuntimeUserCommand("npm", [...command.args], paths.userHome, command.cwd, {
				egressSystemCaFile,
				maxBufferBytes: OFFICIAL_INSTALLER_MAX_BUFFER_BYTES,
				timeoutMs: command.timeoutMs,
			});
		} catch (error) {
			const logPath = writeRuntimeInstallerLog(paths, "hermes-dashboard-prerequisite", { error });
			return `Hermes dashboard prerequisite failed; see ${logPath}`;
		}
		if (result.status !== 0 || result.error) {
			const logPath = writeRuntimeInstallerLog(paths, "hermes-dashboard-prerequisite", result);
			return `Hermes dashboard prerequisite failed; see ${logPath}`;
		}
	}
	if (!existsSync(index)) return `Hermes dashboard prerequisite did not produce ${index}`;
	if (commandRevision) {
		withRuntimeUserFileAccess(() =>
			writePrivateFileAtomic(revisionFile, `${commandRevision}\n`, { mode: 0o600 }),
		);
	}
	return null;
}

function installOfficialRuntimeUserService(
	program: RuntimeSystemdUserProgram,
	paths: RuntimePaths,
	runtimeIdentity: { uid: number; gid: number },
): string | null {
	const descriptor = officialRuntimeServiceDescriptorForProgram(program);
	if (!descriptor) return null;
	const args = descriptor.installArgs;
	if (!commandResolvable(program.command)) {
		return `official ${runtimeSystemdProgramName(program)} service installer command is unavailable: ${program.command}`;
	}
	try {
		const environment = Object.fromEntries(
			(descriptor.installSecretEnv ?? []).flatMap((name) => {
				const value = program.resolvedSecretEnv[name];
				return value ? [[name, value]] : [];
			}),
		);
		const result = spawnRuntimeUserCommand(program.command, args, paths.userHome, program.cwd, {
			environment,
			environmentOverrides:
				descriptor.runtime === "openclaw"
					? {
							OPENCLAW_HOME: undefined,
							OPENCLAW_STATE_DIR: undefined,
							OPENCLAW_CONFIG_PATH: undefined,
						}
					: undefined,
			maxBufferBytes: OFFICIAL_INSTALLER_MAX_BUFFER_BYTES,
			runtimeGid: runtimeIdentity.gid,
			runtimeUid: runtimeIdentity.uid,
			timeoutMs: OFFICIAL_SERVICE_INSTALL_TIMEOUT_MS,
		});
		const logPath = writeRuntimeInstallerLog(
			paths,
			`${runtimeSystemdProgramName(program)}-service`,
			result,
		);
		return result.status === 0 && !result.error
			? null
			: `official ${runtimeSystemdProgramName(program)} service install failed; see ${logPath}`;
	} catch (error) {
		const logPath = writeRuntimeInstallerLog(
			paths,
			`${runtimeSystemdProgramName(program)}-service`,
			{ error },
		);
		return `official ${runtimeSystemdProgramName(program)} service install failed; see ${logPath}`;
	}
}

export function installOfficialRuntimeService(
	item: OfficialRuntimeServicePlan["pending"][number],
	paths: RuntimePaths,
	runtimeIdentity: { uid: number; gid: number },
): string | null {
	const error = installOfficialRuntimeUserService(
		{ ...item.program, cwd: paths.userHome },
		paths,
		runtimeIdentity,
	);
	if (error) return error;
	item.serviceRevision = officialRuntimeServiceRevision(item.program, paths);
	if (!item.serviceRevision) {
		return `official ${runtimeSystemdProgramName(item.program)} service install could not be verified`;
	}
	return null;
}

function uninstallOfficialRuntimeUserService(input: {
	unitName: string;
	paths: RuntimePaths;
	workspaceRoot: string;
}): string | null {
	const descriptor = officialRuntimeServiceDescriptorForUnit(input.unitName);
	if (!descriptor) return null;
	const command = officialRuntimeServiceCommand(descriptor, input.paths);
	if (!commandResolvable(command)) {
		return `official ${input.unitName} uninstaller command is unavailable: ${command}`;
	}
	try {
		runRuntimeUserCommand(
			command,
			descriptor.uninstallArgs,
			"",
			input.paths.userHome,
			input.workspaceRoot,
			{ timeoutMs: OFFICIAL_SERVICE_UNINSTALL_TIMEOUT_MS },
		);
		return null;
	} catch (error) {
		return `official ${input.unitName} uninstall failed: ${
			error instanceof Error ? error.message : String(error)
		}`;
	}
}

export function uninstallStaleOfficialRuntimeServices(input: {
	paths: RuntimePaths;
	unitNames: readonly string[];
	workspaceRoot: string;
}): string[] {
	const errors: string[] = [];
	for (const unitName of input.unitNames) {
		const error = uninstallOfficialRuntimeUserService({
			unitName,
			paths: input.paths,
			workspaceRoot: input.workspaceRoot,
		});
		if (error) errors.push(error);
	}
	return errors;
}

function planStaleRuntimeSystemdFiles(
	paths: RuntimePaths,
	desiredSystemUnits: readonly string[],
	desiredUserUnits: readonly string[],
): RuntimeSystemdStaleFilePlan {
	const platformFiles = new Set<string>();
	const userFiles = new Set<string>();
	const systemUnits = new Set<string>();
	const userUnits = new Set<string>();
	const desiredSystem = new Set(desiredSystemUnits);
	const desiredUser = new Set(desiredUserUnits);
	const managedSystem = new Set([
		"clawdi-runtime-watch.service",
		"clawdi-daemon.service",
		"clawdi-runtime-sidecar.service",
		"clawdi-files.service",
	]);
	if (existsSync(paths.systemdSystemRoot)) {
		for (const entry of readdirSync(paths.systemdSystemRoot)) {
			if (!managedSystem.has(entry) || desiredSystem.has(entry)) continue;
			platformFiles.add(join(paths.systemdSystemRoot, entry));
			systemUnits.add(entry);
		}
	}
	for (const entry of managedRuntimeSystemdUnitEntries(paths.systemdUserRoot)) {
		if (desiredUser.has(entry.unitName)) continue;
		userFiles.add(entry.path);
		userUnits.add(entry.unitName);
	}
	const desiredEnvironmentFiles = new Set(
		[...desiredSystem, ...desiredUser].map((unit) => `${unit}.env`),
	);
	if (existsSync(paths.systemdEnvRoot)) {
		for (const entry of readdirSync(paths.systemdEnvRoot)) {
			if (!entry.endsWith(".service.env") || desiredEnvironmentFiles.has(entry)) continue;
			const path = join(paths.systemdEnvRoot, entry);
			if (!entry.startsWith("clawdi-") && !isGeneratedRuntimeSystemdPath(path)) continue;
			platformFiles.add(path);
		}
	}
	return {
		platformFiles: [...platformFiles].sort(),
		userFiles: [...userFiles].sort(),
		systemUnits: [...systemUnits].sort(),
		userUnits: [...userUnits].sort(),
	};
}

export function removeStaleRuntimeSystemdFiles(plan: RuntimeSystemdStaleFilePlan): string[] {
	const errors: string[] = [];
	const removeFiles = (paths: readonly string[]) => {
		for (const path of paths) {
			try {
				rmSync(path, { force: true });
				if (path.endsWith(`/${RUNTIME_SYSTEMD_DROP_IN_FILE}`) && existsSync(dirname(path))) {
					if (readdirSync(dirname(path)).length === 0) rmdirSync(dirname(path));
				}
			} catch (error) {
				errors.push(error instanceof Error ? error.message : String(error));
			}
		}
	};
	removeFiles(plan.platformFiles);
	withRuntimeUserSystemdFiles(() => removeFiles(plan.userFiles));
	return errors;
}

export function runtimeSystemdCommonEnvironment(paths: RuntimePaths): Record<string, string> {
	const environment: Record<string, string> = {
		HOME: paths.userHome,
		CLAWDI_HOME: paths.clawdiHome,
		CLAWDI_RUNTIME_MODE: "hosted",
		CLAWDI_RUNTIME_USER: "clawdi",
		PATH: runtimeSystemdPath(paths),
		...(paths.serviceStateRoot === DEFAULT_SERVICE_STATE_ROOT
			? {}
			: { CLAWDI_SERVICE_STATE_DIR: paths.serviceStateRoot }),
		...(paths.runRoot === DEFAULT_RUN_ROOT ? {} : { CLAWDI_RUN_DIR: paths.runRoot }),
	};
	return environment;
}

function writeRuntimeSystemdUserProgram(input: {
	program: RuntimeSystemdUserProgram;
	commonEnvironment: Record<string, string>;
	manifest: RuntimeManifest;
	paths: RuntimePaths;
	secretValues: Record<string, string> | undefined;
	providerProjectionRevisions: Partial<Record<string, string | null>>;
	runtimeRevision: Parameters<typeof runtimeSystemdProgramRevision>[4];
}): string {
	const { program } = input;
	const name = runtimeSystemdProgramName(program);
	const runtimeEnv = { ...program.env };
	const descriptor = officialRuntimeServiceDescriptorForProgram(program);
	const isHermesDashboard = program.runtime === "hermes" && program.service === "dashboard";
	const installerOnlySecretEnv =
		descriptor?.runtime === "openclaw" &&
		input.manifest.openclawGatewayAuth?.activation.enabled === true
			? (descriptor.installSecretEnv ?? [])
			: [];
	for (const envName of installerOnlySecretEnv) {
		delete runtimeEnv[envName];
	}
	if (descriptor) delete runtimeEnv.PATH;
	if (descriptor || isHermesDashboard) delete runtimeEnv.CLAWDI_AUTH_TOKEN;
	const revision = runtimeSystemdProgramRevision(
		input.manifest,
		program,
		input.secretValues,
		input.providerProjectionRevisions,
		input.runtimeRevision,
	);
	const isNativeRuntimeService = descriptor !== null || isHermesDashboard;
	const env: Record<string, string> = isNativeRuntimeService
		? {
				...(isHermesDashboard ? { HOME: input.paths.userHome } : {}),
				...runtimeEnv,
				CLAWDI_MANAGED_CONTENT_DIGEST: revision,
			}
		: {
				...input.commonEnvironment,
				...runtimeEnv,
				CLAWDI_AUTH_TOKEN: "",
				CLAWDI_HOME: input.paths.clawdiHome,
				CLAWDI_MANAGED_CONTENT_DIGEST: revision,
			};
	if (officialRuntimeServiceInstallArgs(program)) {
		return writeSystemdUserEnvironmentDropIn({
			paths: input.paths,
			name,
			env,
			unsetEnvironment: ["CLAWDI_AUTH_TOKEN"],
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
		unsetEnvironment: isHermesDashboard ? ["CLAWDI_AUTH_TOKEN"] : undefined,
	});
}

function writeFileBrowserSystemdUnit(input: {
	program: RuntimeSystemdUserProgram;
	manifest: RuntimeManifest;
	paths: RuntimePaths;
	runtimeIdentity: { uid: number; gid: number };
}): string {
	const companion = input.manifest.companions?.filebrowser;
	if (!companion) throw new Error("Files systemd unit requires a companion manifest");
	const runtimeUser = process.env.CLAWDI_RUNTIME_USER?.trim() || "clawdi";
	if (runtimeUser === "root" || runtimeUser === "0") {
		throw new Error("Files systemd unit requires a non-root tenant runtime user");
	}
	const serviceConfig = join(dirname(input.paths.fileBrowserServiceBinary), "filebrowser.yaml");
	return writeSystemdSystemUnit({
		paths: input.paths,
		name: "clawdi-files",
		description: "Clawdi hosted Files companion",
		command: input.program.command,
		args: input.program.args,
		execStart: fileBrowserSystemdExec(input.paths.fileBrowserServiceBinary, serviceConfig),
		cwd: input.program.cwd,
		directoryKind: "file-browser",
		env: {
			HOME: "/nonexistent",
			CLAWDI_MANAGED_CONTENT_DIGEST: runtimeImpactRevision({
				companion: input.manifest.companions?.filebrowser ?? null,
			}),
		},
		extraUnitLines: ["After=network-online.target", "Wants=network-online.target"],
		extraServiceLines: [
			`User=${runtimeUser}`,
			`Group=${input.runtimeIdentity.gid}`,
			// Publish only this verified executable into the component service's
			// private runtime directory; the platform state root stays untraversable.
			`BindReadOnlyPaths=${systemdPath(input.program.command)}:${systemdPath(input.paths.fileBrowserServiceBinary)}:norbind`,
			`BindReadOnlyPaths=${systemdPath(input.paths.fileBrowserConfig)}:${systemdPath(serviceConfig)}:norbind`,
			`ExecStartPre=${fileBrowserVersionProbeExec(
				input.paths.fileBrowserServiceBinary,
				companion.version,
				companion.commit,
			)}`,
			"UMask=0077",
			"NoNewPrivileges=true",
			"PrivateTmp=true",
			"PrivateDevices=true",
			"ProtectSystem=strict",
			"ProtectHome=tmpfs",
			`BindPaths=${systemdPath(input.paths.userHome)}`,
			`ReadWritePaths=${systemdPath(input.paths.userHome)}`,
			`NoExecPaths=${systemdPath(input.paths.userHome)} ${systemdPath(input.paths.fileBrowserStateRoot)}`,
			"ProtectKernelTunables=true",
			"ProtectKernelModules=true",
			"ProtectKernelLogs=true",
			"ProtectControlGroups=true",
			"ProtectClock=true",
			"ProtectHostname=true",
			"ProtectProc=invisible",
			"ProcSubset=pid",
			"PrivatePIDs=true",
			"LockPersonality=true",
			"RestrictSUIDSGID=true",
			"RestrictRealtime=true",
			"RestrictNamespaces=true",
			"KeyringMode=private",
			"RemoveIPC=true",
			"RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
			"CapabilityBoundingSet=",
			"AmbientCapabilities=",
			"SystemCallArchitectures=native",
			"TasksMax=128",
		],
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

export function writeRuntimeSidecarSystemdUnit(input: {
	program: RuntimeEgressSystemdProgram;
	identity: RuntimeEgressIdentity;
	manifest: RuntimeManifest;
	paths: RuntimePaths;
	workspaceRoot: string;
	commonEnvironment: Record<string, string>;
}): string {
	return writeSystemdSystemUnit({
		paths: input.paths,
		name: "clawdi-runtime-sidecar",
		description: "Clawdi hosted runtime sidecar",
		command: input.paths.cliManagedBin,
		args: ["runtime", "sidecar"],
		cwd: input.workspaceRoot,
		env: {
			...input.commonEnvironment,
			CLAWDI_AUTH_TOKEN: "",
			CLAWDI_EGRESS_ENV_FILE: input.program.envFilePath,
			CLAWDI_MANAGED_CONTENT_DIGEST: runtimeImpactRevision({
				program: runtimeSidecarProgramRevision(input.manifest, input.program, input.identity),
				secretFile: input.program.secretFilePath
					? readFileSync(input.program.secretFilePath, "utf8")
					: null,
			}),
		},
		serviceType: "notify",
		extraUnitLines: [`Before=user@${input.identity.runtimeUid}.service`],
		extraServiceLines: [
			"NotifyAccess=main",
			// The egress process drops to its dedicated UID. Publish only the
			// verified engine into this unit's private mount namespace.
			`BindReadOnlyPaths=${systemdPath(input.program.engine.binaryPath)}:${systemdPath(input.paths.egressServiceBinary)}:norbind`,
		],
	});
}

export function writeRuntimeSystemdState(input: {
	runtimePrograms: RuntimeSystemdUserProgram[];
	egressProgram: RuntimeEgressSystemdProgram | null;
	egressIdentity: RuntimeEgressIdentity | null;
	runtimeIdentity: { uid: number; gid: number };
	manifest: RuntimeManifest;
	paths: RuntimePaths;
	workspaceRoot: string;
	daemonAuthTokenFile: string | null;
	secretValues: Record<string, string> | undefined;
	providerProjectionRevisions: Partial<Record<string, string | null>>;
	runtimeRevision: Parameters<typeof runtimeSystemdProgramRevision>[4];
	commonEnvironment: Record<string, string>;
	deferredRuntimeUserUnitNames?: readonly string[];
}): {
	systemUnits: string[];
	userUnits: string[];
	egressSidecarActive: boolean;
	staleFiles: RuntimeSystemdStaleFilePlan;
} {
	const {
		runtimePrograms,
		egressProgram,
		egressIdentity,
		runtimeIdentity,
		manifest,
		paths,
		workspaceRoot,
		daemonAuthTokenFile,
		secretValues,
		providerProjectionRevisions,
		runtimeRevision,
		commonEnvironment,
	} = input;
	const systemUnits: string[] = [];
	const shouldRunEgress = egressProgram !== null && runtimePrograms.length > 0;
	const activeEgressProgram = shouldRunEgress ? egressProgram : null;
	const activeEgressIdentity = shouldRunEgress ? egressIdentity : null;
	const userUnits: string[] = [];
	const deferredRuntimeUserUnitNames = new Set(input.deferredRuntimeUserUnitNames ?? []);
	const desiredSystemUnitNames = [
		...(daemonAuthTokenFile ? ["clawdi-runtime-watch.service", "clawdi-daemon.service"] : []),
		...(activeEgressProgram ? ["clawdi-runtime-sidecar.service"] : []),
		...(runtimePrograms.some((program) => program.programKind === "file-browser")
			? ["clawdi-files.service"]
			: []),
	];
	const desiredUserUnitNames = runtimePrograms
		.filter((program) => program.programKind !== "file-browser")
		.map((program) => systemdUnitFileName(runtimeSystemdProgramName(program)));
	const staleFiles = planStaleRuntimeSystemdFiles(
		paths,
		desiredSystemUnitNames,
		desiredUserUnitNames,
	);
	if (daemonAuthTokenFile) {
		systemUnits.push(
			writeSystemdSystemUnit({
				paths,
				name: "clawdi-runtime-watch",
				description: "Clawdi hosted runtime desired-state watcher",
				command: paths.cliManagedBin,
				args: ["runtime", "watch"],
				cwd: workspaceRoot,
				directoryKind: "platform",
				env: {
					...commonEnvironment,
					CLAWDI_AUTH_TOKEN: "",
				},
				extraServiceLines: ["TasksMax=infinity"],
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
					CLAWDI_STATE_DIR: paths.daemonStateRoot,
					CLAWDI_API_URL: manifest.controlPlane.apiUrl,
					CLAWDI_NO_AUTO_UPDATE: "1",
					CLAWDI_NO_UPDATE_CHECK: "1",
					CLAWDI_MANAGED_CONTENT_DIGEST: runtimeImpactRevision({
						program: daemonProgramRevision(manifest),
						authToken: readFileSync(daemonAuthTokenFile, "utf8"),
					}),
				},
			}),
		);
	}

	if (activeEgressProgram) {
		if (!activeEgressIdentity) {
			throw new Error("runtime sidecar egress revision requires the configured numeric identity");
		}
		systemUnits.push(
			writeRuntimeSidecarSystemdUnit({
				program: activeEgressProgram,
				identity: activeEgressIdentity,
				manifest,
				paths,
				workspaceRoot,
				commonEnvironment,
			}),
		);
	}

	for (const program of runtimePrograms) {
		if (program.programKind === "file-browser") {
			systemUnits.push(
				writeFileBrowserSystemdUnit({
					program,
					manifest,
					paths,
					runtimeIdentity,
				}),
			);
			continue;
		}
		if (deferredRuntimeUserUnitNames.has(runtimeSystemdUserUnitName(program))) {
			removeGeneratedRuntimeBaseUnit(paths, runtimeSystemdUserUnitName(program));
			removeSystemdUserEnvironmentDropIn(paths, runtimeSystemdProgramName(program));
			continue;
		}
		userUnits.push(
			writeRuntimeSystemdUserProgram({
				program,
				commonEnvironment,
				manifest,
				paths,
				secretValues,
				providerProjectionRevisions,
				runtimeRevision,
			}),
		);
	}
	return {
		systemUnits,
		userUnits,
		egressSidecarActive: shouldRunEgress,
		staleFiles,
	};
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
