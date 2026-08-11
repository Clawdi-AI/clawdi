import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmdirSync,
	rmSync,
	statSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { writePrivateFileAtomic } from "../lib/private-file";
import { stripTerminalEscapes } from "../lib/sanitize";
import { ensureDirectoryWithinTrustedRoot } from "../lib/trusted-directory";
import { runtimeContentSha256 } from "./applied-state";
import { applyEgressTransparentRuntimeEnv } from "./egress-env";
import { FILE_BROWSER_SERVICE_GROUP, FILE_BROWSER_SERVICE_USER } from "./file-browser-isolation";
import type { RuntimeInstallReceiptEntry, RuntimeInstallReceipts } from "./install-receipts";
import type { RuntimeManifest } from "./manifest-contract";
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
	RuntimeUserCommandTimeoutError,
	runRuntimeUserCommand,
	runtimeEgressGid,
	runtimeEgressUid,
	runtimeUserGid,
	runtimeUserUid,
	spawnRuntimeUserCommand,
	withRuntimeUserFileAccess,
} from "./runtime-user-command";
import { runtimeSecretValue } from "./secret-values";
import {
	GENERATED_RUNTIME_SYSTEMD_FILE_HEADER,
	isGeneratedRuntimeSystemdFile,
} from "./systemd-user";
import { TRANSPARENT_EGRESS_PORT } from "./transparent-egress";

function runtimeCommandPath(name: string, home: string): string | null {
	if (name === "openclaw") return join(home, ".local", "bin", "openclaw");
	if (name === "hermes") return join(home, ".local", "bin", "hermes");
	return null;
}

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

export interface RuntimeInstallReceiptTarget {
	desiredRevision: string;
	currentRevision: () => string | null;
	expectedCurrentRevision: string | null;
}

export interface OfficialRuntimeServicePlan {
	targets: Map<string, RuntimeInstallReceiptTarget>;
	pending: Array<{ program: RuntimeSystemdUserProgram; target: RuntimeInstallReceiptTarget }>;
}

export interface HermesDashboardArtifactPlan {
	program: RuntimeSystemdUserProgram | null;
	receiptKey: string | null;
	target: RuntimeInstallReceiptTarget | null;
}

export interface RuntimeSystemdUserMutationPlan {
	targets: string[];
	symlinkTargets: string[];
	environmentTargets: string[];
	metadataTargets: string[];
	unitNames: string[];
	staleOfficialUnits: string[];
	driftErrors: string[];
}

export interface RuntimeSystemdStaleFilePlan {
	files: string[];
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
	runtimeUser: string;
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

const RUNTIME_SYSTEMD_DROP_IN_FILE = "10-clawdi-hosted.conf";
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
		const result = spawnRuntimeUserCommand(command, ["--version"], home, cwd, {
			timeoutMs: RUNTIME_VERSION_PROBE_TIMEOUT_MS,
		});
		if (result.error && "code" in result.error && result.error.code === "ETIMEDOUT") {
			throw new RuntimeUserCommandTimeoutError(
				`runtime --version probe for ${command}`,
				RUNTIME_VERSION_PROBE_TIMEOUT_MS,
			);
		}
		if (result.status !== 0) return null;
		const stdout = Buffer.isBuffer(result.stdout) ? result.stdout.toString("utf8") : result.stdout;
		const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8") : result.stderr;
		const version = [stdout, stderr].filter(Boolean).join("\n").trim();
		return version ? runtimeContentSha256({ executableRevision, version }) : null;
	} catch (error) {
		if (error instanceof RuntimeUserCommandTimeoutError) throw error;
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
	} catch (error) {
		if (error instanceof RuntimeUserCommandTimeoutError) throw error;
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
	executeInstallers: boolean,
): OfficialRuntimeServicePlan {
	const targets = new Map<string, RuntimeInstallReceiptTarget>();
	const pending: OfficialRuntimeServicePlan["pending"] = [];
	if (!executeInstallers) return { targets, pending };
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

// Hermes upstream bounds Node dependency installation at 600s and declares
// npm "<11.10.0 || >=12.0.0" in its root package.json:
// https://github.com/NousResearch/hermes-agent/blob/4b60979dc188655eb4fb81abf292890147ec2d4c/scripts/install.sh#L2797-L2803
// https://github.com/NousResearch/hermes-agent/blob/4b60979dc188655eb4fb81abf292890147ec2d4c/package.json#L55-L58
const HERMES_NPM_VERSION_TIMEOUT_MS = 30_000;
const HERMES_NPM_INSTALL_TIMEOUT_MS = 600_000;
const HERMES_DASHBOARD_BUILD_TIMEOUT_MS = 900_000;
const RUNTIME_VERSION_PROBE_TIMEOUT_MS = 10_000;
const OFFICIAL_SERVICE_INSTALL_TIMEOUT_MS = 600_000;
const OFFICIAL_SERVICE_UNINSTALL_TIMEOUT_MS = 120_000;
const RUNTIME_SYSTEMCTL_MAINTENANCE_TIMEOUT_MS = 15_000;
// This key deliberately reuses the existing officialServices receipt group:
// the artifact is a prerequisite of Clawdi's compatibility dashboard service,
// not a new install authority or receipt schema.
const HERMES_DASHBOARD_ARTIFACT_RECEIPT = "hermes-dashboard:artifact";
const HERMES_DASHBOARD_NPM_CONSTRAINT = "<11.10.0 || >=12.0.0";

function isHermesDashboardProgram(program: RuntimeSystemdUserProgram): boolean {
	return program.runtime === "hermes" && program.service === "dashboard";
}

function hermesDashboardArtifactIndex(paths: RuntimePaths): string {
	return join(paths.userHome, ".hermes", "hermes-agent", "hermes_cli", "web_dist", "index.html");
}

function hermesDashboardArtifactCurrentRevision(paths: RuntimePaths): string | null {
	const root = dirname(hermesDashboardArtifactIndex(paths));
	try {
		const rootStat = lstatSync(root);
		if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return null;
		const files: Array<{ path: string; contentSha256: string }> = [];
		const visit = (directory: string, relativeDirectory: string): boolean => {
			for (const entry of readdirSync(directory, { withFileTypes: true })) {
				const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
				const path = join(directory, entry.name);
				if (entry.isSymbolicLink()) return false;
				if (entry.isDirectory()) {
					if (!visit(path, relativePath)) return false;
					continue;
				}
				if (!entry.isFile()) return false;
				files.push({
					path: relativePath,
					contentSha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
				});
			}
			return true;
		};
		if (!visit(root, "") || !files.some((file) => file.path === "index.html")) return null;
		return runtimeContentSha256(files.sort((left, right) => left.path.localeCompare(right.path)));
	} catch {
		return null;
	}
}

function hermesDashboardArtifactDesiredRevision(commandRevision: string): string {
	return runtimeContentSha256({
		commandRevision,
		npmConstraint: HERMES_DASHBOARD_NPM_CONSTRAINT,
		commands: ["npm install --workspace web", "npm run build -w web"],
		installTimeoutMs: HERMES_NPM_INSTALL_TIMEOUT_MS,
		buildTimeoutMs: HERMES_DASHBOARD_BUILD_TIMEOUT_MS,
	});
}

export function planHermesDashboardArtifact(
	programs: RuntimeSystemdUserProgram[],
	paths: RuntimePaths,
	receipts: RuntimeInstallReceipts | null,
	executePrerequisites: boolean,
): HermesDashboardArtifactPlan {
	if (!executePrerequisites) return { program: null, receiptKey: null, target: null };
	const program = programs.find(isHermesDashboardProgram);
	if (!program) return { program: null, receiptKey: null, target: null };
	const command = runtimeCommandPath("hermes", paths.userHome) ?? program.command;
	const commandRevision = runtimeCommandCurrentRevision(command, paths.userHome, paths.userHome);
	const desiredRevision = commandRevision
		? hermesDashboardArtifactDesiredRevision(commandRevision)
		: "";
	const currentRevision = () => hermesDashboardArtifactCurrentRevision(paths);
	const expectedCurrentRevision = commandRevision
		? verifiedReceiptCurrentRevision(
				receipts?.officialServices[HERMES_DASHBOARD_ARTIFACT_RECEIPT],
				desiredRevision,
				currentRevision,
			)
		: null;
	return {
		program,
		receiptKey: HERMES_DASHBOARD_ARTIFACT_RECEIPT,
		target: { desiredRevision, currentRevision, expectedCurrentRevision },
	};
}

function supportedHermesNpmVersion(version: string): boolean {
	const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
	if (!match) return false;
	const major = Number(match[1]);
	const minor = Number(match[2]);
	return major < 11 || (major === 11 && minor < 10) || major >= 12;
}

function validateHermesNpmVersion(
	paths: RuntimePaths,
	appRoot: string,
	egressSystemCaFile?: string,
): string | null {
	const result = spawnRuntimeUserCommand("npm", ["--version"], paths.userHome, appRoot, {
		timeoutMs: HERMES_NPM_VERSION_TIMEOUT_MS,
		egressSystemCaFile,
	});
	if (result.status !== 0 || result.error) {
		return `Hermes dashboard prerequisite could not determine npm version: ${
			result.error?.message ?? `npm exited ${result.status ?? "without status"}`
		}`;
	}
	const version = String(result.stdout ?? "").trim();
	if (!supportedHermesNpmVersion(version)) {
		return `Hermes dashboard prerequisite requires npm <11.10.0 or >=12.0.0; found ${
			version || "an unrecognized version"
		}`;
	}
	return null;
}

export function prepareHermesDashboardArtifact(
	plan: HermesDashboardArtifactPlan,
	paths: RuntimePaths,
	egressSystemCaFile?: string,
): string | null {
	if (!plan.program || !plan.target || plan.target.expectedCurrentRevision) return null;
	const appRoot = join(paths.userHome, ".hermes", "hermes-agent");
	const command = runtimeCommandPath("hermes", paths.userHome) ?? plan.program.command;
	const commandRevision = runtimeCommandCurrentRevision(command, paths.userHome, paths.userHome);
	if (!commandRevision) {
		return `Hermes dashboard prerequisite could not determine the installed Hermes command revision: ${command}`;
	}
	plan.target.desiredRevision = hermesDashboardArtifactDesiredRevision(commandRevision);
	if (!commandResolvable("npm")) {
		return "Hermes dashboard prerequisite command is unavailable: npm";
	}
	const versionError = validateHermesNpmVersion(paths, appRoot, egressSystemCaFile);
	if (versionError) return versionError;
	try {
		runRuntimeUserCommand("npm", ["install", "--workspace", "web"], "", paths.userHome, appRoot, {
			timeoutMs: HERMES_NPM_INSTALL_TIMEOUT_MS,
			egressSystemCaFile,
		});
		runRuntimeUserCommand("npm", ["run", "build", "-w", "web"], "", paths.userHome, appRoot, {
			timeoutMs: HERMES_DASHBOARD_BUILD_TIMEOUT_MS,
			egressSystemCaFile,
		});
		const currentRevision = hermesDashboardArtifactCurrentRevision(paths);
		if (!currentRevision) {
			return `Hermes dashboard prerequisite did not produce ${hermesDashboardArtifactIndex(paths)}`;
		}
		plan.target.expectedCurrentRevision = currentRevision;
		return null;
	} catch (error) {
		return `Hermes dashboard prerequisite failed: ${
			error instanceof Error ? error.message : String(error)
		}`;
	}
}

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
	writePrivateFileAtomic(path, `${GENERATED_RUNTIME_SYSTEMD_FILE_HEADER}\n${lines.join("\n")}\n`, {
		mode: 0o600,
		dirMode: 0o711,
		trustedRoot: input.paths.runRoot,
	});
	if (input.owner === "runtime-user") makeRuntimeUserOwned(path);
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
		envRevision: runtimeImpactRevision({
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
	execStart?: string;
	serviceType?: "simple" | "oneshot" | "notify";
	restart?: boolean;
	directoryKind?: "platform" | "file-browser";
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
		ensureDirectoryWithinTrustedRoot(input.root, input.root);
		if (input.owner === "runtime-user") makeRuntimeUserOwned(input.root);
		writePrivateFileAtomic(path, `${lines.join("\n")}`, {
			mode: 0o644,
			dirMode: 0o755,
			trustedRoot: input.root,
		});
		if (input.owner === "runtime-user") makeRuntimeUserOwned(path);
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
		ensureDirectoryWithinTrustedRoot(input.paths.systemdUserRoot, dirname(path));
		makeRuntimeUserOwned(dirname(path));
		writePrivateFileAtomic(path, `${lines.join("\n")}`, {
			mode: 0o644,
			dirMode: 0o755,
			trustedRoot: input.paths.systemdUserRoot,
		});
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

const OFFICIAL_INSTALLER_MAX_BUFFER_BYTES = 64 * 1024;
const OFFICIAL_INSTALLER_OUTPUT_TAIL_CHARACTERS = 4000;
const SENSITIVE_ENV_KEY_SEGMENT =
	/(?:^|_)(?:API_KEY|AUTH|COOKIE|CREDENTIAL|KEY|PASSWORD|PASSWD|PRIVATE_KEY|SECRET|SESSION|TOKEN)(?:$|_)/i;
const ENV_ASSIGNMENT = /\b([A-Za-z_][A-Za-z0-9_]*)=(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s]+)/g;
const BEARER_CREDENTIAL = /\b(Bearer)\s+[^\s,"'}\]]+/gi;
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi;
const SENSITIVE_URL_VALUE =
	/([?&#](?:access_token|api_key|auth|authorization|client_secret|credential|key|password|refresh_token|secret|token)=)[^&#\s]+/gi;
const SENSITIVE_STRUCTURED_VALUE =
	/((?:["']?(?:access[_-]?token|api[_-]?key|auth(?:orization)?|credential|password|private[_-]?key|secret|token)["']?)\s*:\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,}\]]+)/gi;

function officialInstallerSecretValues(program: RuntimeSystemdUserProgram): string[] {
	const values = new Set(Object.values(program.resolvedSecretEnv).filter(Boolean));
	for (const [key, value] of Object.entries(program.env)) {
		if (value && SENSITIVE_ENV_KEY_SEGMENT.test(key)) values.add(value);
	}
	for (const [key, value] of Object.entries(process.env)) {
		if (value && value.length >= 8 && SENSITIVE_ENV_KEY_SEGMENT.test(key)) values.add(value);
	}
	return [...values].sort((left, right) => right.length - left.length);
}

function officialInstallerJsonDiagnostic(value: string): string | null | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const record = parsed as Record<string, unknown>;
	const diagnostic: Record<string, unknown> = {};
	for (const key of ["error", "message"] as const) {
		if (typeof record[key] === "string" && record[key]) diagnostic[key] = record[key];
	}
	for (const key of ["hints", "warnings"] as const) {
		if (!Array.isArray(record[key])) continue;
		const strings = record[key]
			.filter((item): item is string => typeof item === "string")
			.slice(-10);
		if (strings.length > 0) diagnostic[key] = strings;
	}
	return Object.keys(diagnostic).length > 0 ? JSON.stringify(diagnostic) : null;
}

function redactOfficialInstallerOutput(value: string, secrets: readonly string[]): string {
	let redacted = stripTerminalEscapes(value);
	for (const secret of secrets) redacted = redacted.replaceAll(secret, "<redacted>");
	return redacted
		.replace(ENV_ASSIGNMENT, "$1=<redacted>")
		.replace(BEARER_CREDENTIAL, "$1 <redacted>")
		.replace(URL_USERINFO, "$1<redacted>@")
		.replace(SENSITIVE_URL_VALUE, "$1<redacted>")
		.replace(SENSITIVE_STRUCTURED_VALUE, '$1"<redacted>"');
}

function officialInstallerOutputTail(
	value: string | Buffer | null | undefined,
	secrets: readonly string[],
	options: { requireJson?: boolean } = {},
): string | null {
	const raw = String(value ?? "").trim();
	if (!raw) return null;
	const jsonDiagnostic = officialInstallerJsonDiagnostic(raw);
	const diagnostic =
		jsonDiagnostic === undefined ? (options.requireJson ? null : raw) : jsonDiagnostic;
	if (!diagnostic) return null;
	const redacted = redactOfficialInstallerOutput(diagnostic, secrets).trim();
	return redacted ? redacted.slice(-OFFICIAL_INSTALLER_OUTPUT_TAIL_CHARACTERS) : null;
}

function officialInstallerFailureDetail(
	program: RuntimeSystemdUserProgram,
	result: ReturnType<typeof spawnRuntimeUserCommand>,
): string {
	const secrets = officialInstallerSecretValues(program);
	const spawnError = result.error
		? officialInstallerOutputTail(result.error.message, secrets)
		: null;
	const stdout = officialInstallerOutputTail(result.stdout, secrets, {
		requireJson: officialRuntimeServiceInstallArgs(program)?.includes("--json") === true,
	});
	const stderr = officialInstallerOutputTail(result.stderr, secrets);
	const details = [
		`exit code ${result.status ?? "unavailable"}`,
		result.signal ? `signal ${result.signal}` : null,
		result.error ? `spawn error: ${spawnError ?? "unknown"}` : null,
		stdout ? `stdout tail: ${stdout}` : null,
		stderr ? `stderr tail: ${stderr}` : null,
	].filter((detail): detail is string => detail !== null);
	return details.join("; ");
}

function installOfficialRuntimeUserService(
	program: RuntimeSystemdUserProgram,
	paths: RuntimePaths,
): string | null {
	const descriptor = officialRuntimeServiceDescriptorForProgram(program);
	if (!descriptor) return null;
	const args = descriptor.installArgs;
	if (!commandResolvable(program.command)) {
		return `official ${runtimeSystemdProgramName(program)} service installer command is unavailable: ${program.command}`;
	}
	try {
		resetFailedRuntimeUserService(runtimeSystemdProgramName(program), paths, program.cwd);
		const result = spawnRuntimeUserCommand(program.command, args, paths.userHome, program.cwd, {
			maxBufferBytes: OFFICIAL_INSTALLER_MAX_BUFFER_BYTES,
			timeoutMs: OFFICIAL_SERVICE_INSTALL_TIMEOUT_MS,
		});
		if (result.error && "code" in result.error && result.error.code === "ETIMEDOUT") {
			return `official ${runtimeSystemdProgramName(program)} service install timed out after ${OFFICIAL_SERVICE_INSTALL_TIMEOUT_MS}ms`;
		}
		return result.status === 0 && !result.error
			? null
			: `official ${runtimeSystemdProgramName(program)} service install failed: ${officialInstallerFailureDetail(program, result)}`;
	} catch (error) {
		const secrets = officialInstallerSecretValues(program);
		const detail = officialInstallerOutputTail(
			error instanceof Error ? error.message : String(error),
			secrets,
		);
		return `official ${runtimeSystemdProgramName(program)} service install failed: ${
			detail ?? "unknown error"
		}`;
	}
}

export function installOfficialRuntimeService(
	item: OfficialRuntimeServicePlan["pending"][number],
	paths: RuntimePaths,
): string | null {
	reloadRuntimeUserManager(paths, paths.userHome);
	const error = installOfficialRuntimeUserService({ ...item.program, cwd: paths.userHome }, paths);
	if (error) return error;
	const currentRevision = item.target.currentRevision();
	if (!currentRevision) {
		return `official ${runtimeSystemdProgramName(item.program)} service install could not be verified`;
	}
	item.target.expectedCurrentRevision = currentRevision;
	return null;
}

function resetFailedRuntimeUserService(name: string, paths: RuntimePaths, cwd: string): void {
	try {
		runRuntimeUserCommand(
			process.env.CLAWDI_SYSTEMCTL_PATH?.trim() || "systemctl",
			["--user", "reset-failed", systemdUnitFileName(name)],
			"",
			paths.userHome,
			cwd,
			{ timeoutMs: RUNTIME_SYSTEMCTL_MAINTENANCE_TIMEOUT_MS },
		);
	} catch {
		// The unit may not exist yet; reset-failed must never block convergence.
	}
}

function reloadRuntimeUserManager(paths: RuntimePaths, cwd: string): void {
	try {
		runRuntimeUserCommand(
			process.env.CLAWDI_SYSTEMCTL_PATH?.trim() || "systemctl",
			["--user", "daemon-reload"],
			"",
			paths.userHome,
			cwd,
			{ timeoutMs: RUNTIME_SYSTEMCTL_MAINTENANCE_TIMEOUT_MS },
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

function systemdUnitNameFromPath(unitPath: string): string {
	return unitPath.split("/").at(-1) ?? "";
}

function foreignRuntimeSystemdUserDropIns(paths: RuntimePaths, unitName: string): string[] {
	const dropInRoot = join(paths.systemdUserRoot, `${unitName}.d`);
	let rootStat: ReturnType<typeof lstatSync>;
	try {
		rootStat = lstatSync(dropInRoot);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return [dropInRoot];
	// systemd merges only *.conf files from unit drop-in directories:
	// https://www.freedesktop.org/software/systemd/man/latest/systemd.unit.html
	return readdirSync(dropInRoot)
		.filter((entry) => entry.endsWith(".conf") && entry !== RUNTIME_SYSTEMD_DROP_IN_FILE)
		.map((entry) => join(dropInRoot, entry))
		.sort();
}

function officialRuntimeSystemdUserDropInDriftErrors(
	programs: RuntimeSystemdUserProgram[],
	paths: RuntimePaths,
): string[] {
	const errors: string[] = [];
	for (const program of officialRuntimeSystemdPrograms(programs)) {
		const unitName = systemdUnitFileName(runtimeSystemdProgramName(program));
		const foreignDropIns = foreignRuntimeSystemdUserDropIns(paths, unitName);
		if (foreignDropIns.length === 0) continue;
		errors.push(
			`foreign systemd drop-in drift detected for ${unitName}; refusing to reconcile the platform override while these drop-ins exist: ${foreignDropIns
				.map((path) => JSON.stringify(path))
				.join(", ")}`,
		);
	}
	return errors;
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
		const dropInPath = join(paths.systemdUserRoot, entry, RUNTIME_SYSTEMD_DROP_IN_FILE);
		if (!isGeneratedSystemdFile(dropInPath)) continue;
		const baseUnitPath = join(paths.systemdUserRoot, unitName);
		if (!existsSync(baseUnitPath) || isGeneratedSystemdFile(baseUnitPath)) continue;
		stale.push(unitName);
	}
	return stale.sort();
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

export function planRuntimeSystemdUserMutations(
	programs: RuntimeSystemdUserProgram[],
	paths: RuntimePaths,
): RuntimeSystemdUserMutationPlan {
	const targets = new Set<string>();
	const symlinkTargets = new Set<string>();
	const environmentTargets = new Set<string>();
	const unitNames = new Set<string>();
	const metadataTargets = new Set<string>([
		dirname(paths.systemdUserRoot),
		paths.systemdUserRoot,
		join(paths.systemdUserRoot, "default.target.wants"),
	]);
	const writtenUnits = programs
		.map((program) => {
			if (program.programKind === "file-browser") return null;
			const name = runtimeSystemdProgramName(program);
			const unitName = systemdUnitFileName(name);
			unitNames.add(unitName);
			const unitPath = join(paths.systemdUserRoot, unitName);
			environmentTargets.add(systemdEnvironmentFilePath(paths, name));
			targets.add(unitPath);
			const enablementPath = join(paths.systemdUserRoot, "default.target.wants", unitName);
			targets.add(enablementPath);
			symlinkTargets.add(enablementPath);
			if (officialRuntimeServiceInstallArgs(program)) {
				if (program.runtime === "openclaw") {
					// OpenClaw's official Linux installer writes the base unit in place and
					// preserves the previous unit beside it. Both are official-user
					// transaction mutations:
					// https://github.com/openclaw/openclaw/blob/ba467fbd3efa9ab109e620c4e42cfe92388171c5/src/daemon/systemd.ts#L985-L1004
					targets.add(`${unitPath}.bak`);
					// The same installer may write its owner-only environment file under
					// the OpenClaw state directory:
					// https://github.com/openclaw/openclaw/blob/ba467fbd3efa9ab109e620c4e42cfe92388171c5/src/daemon/systemd.ts#L1099-L1170
					targets.add(join(paths.userHome, ".openclaw", "gateway.systemd.env"));
				}
				const dropInPath = systemdDropInFilePath(paths, name);
				targets.add(dropInPath);
				metadataTargets.add(dirname(dropInPath));
			}
			return unitPath;
		})
		.filter((path): path is string => path !== null);

	if (existsSync(paths.systemdUserRoot)) {
		const writtenNames = new Set(writtenUnits.map(systemdUnitNameFromPath));
		for (const entry of readdirSync(paths.systemdUserRoot)) {
			if (entry.endsWith(".service")) {
				const path = join(paths.systemdUserRoot, entry);
				if (
					(entry.startsWith("clawdi-") || isGeneratedSystemdFile(path)) &&
					!writtenNames.has(entry)
				) {
					targets.add(path);
					const enablementPath = join(paths.systemdUserRoot, "default.target.wants", entry);
					targets.add(enablementPath);
					symlinkTargets.add(enablementPath);
					unitNames.add(entry);
				}
				continue;
			}
			if (!entry.endsWith(".service.d")) continue;
			const unitName = entry.slice(0, -".d".length);
			const dropInPath = join(paths.systemdUserRoot, entry, RUNTIME_SYSTEMD_DROP_IN_FILE);
			if (!isGeneratedSystemdFile(dropInPath) || writtenNames.has(unitName)) continue;
			targets.add(dropInPath);
			const enablementPath = join(paths.systemdUserRoot, "default.target.wants", unitName);
			targets.add(enablementPath);
			symlinkTargets.add(enablementPath);
			metadataTargets.add(dirname(dropInPath));
			unitNames.add(unitName);
		}
	}
	if (existsSync(paths.systemdEnvRoot)) {
		for (const entry of readdirSync(paths.systemdEnvRoot)) {
			if (!entry.endsWith(".service.env")) continue;
			const path = join(paths.systemdEnvRoot, entry);
			if (entry.startsWith("clawdi-") || isGeneratedSystemdFile(path)) {
				environmentTargets.add(path);
			}
		}
	}

	const staleOfficialUnits = staleOfficialRuntimeUserServices(paths, writtenUnits);
	return {
		targets: [...targets].sort(),
		symlinkTargets: [...symlinkTargets].sort(),
		environmentTargets: [...environmentTargets].sort(),
		metadataTargets: [...metadataTargets].sort(),
		unitNames: [...unitNames].sort(),
		staleOfficialUnits,
		driftErrors: officialRuntimeSystemdUserDropInDriftErrors(programs, paths),
	};
}

function isGeneratedSystemdFile(path: string): boolean {
	try {
		return isGeneratedRuntimeSystemdFile(readFileSync(path, "utf-8"));
	} catch {
		return false;
	}
}

function planStaleRuntimeSystemdFiles(
	paths: RuntimePaths,
	desiredSystemUnits: readonly string[],
	desiredUserUnits: readonly string[],
): RuntimeSystemdStaleFilePlan {
	const files = new Set<string>();
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
			files.add(join(paths.systemdSystemRoot, entry));
			systemUnits.add(entry);
		}
	}
	if (existsSync(paths.systemdUserRoot)) {
		for (const entry of readdirSync(paths.systemdUserRoot)) {
			if (entry.endsWith(".service")) {
				const path = join(paths.systemdUserRoot, entry);
				if (desiredUser.has(entry)) continue;
				if (!entry.startsWith("clawdi-") && !isGeneratedSystemdFile(path)) continue;
				files.add(path);
				files.add(join(paths.systemdUserRoot, "default.target.wants", entry));
				userUnits.add(entry);
				continue;
			}
			if (!entry.endsWith(".service.d")) continue;
			const unitName = entry.slice(0, -".d".length);
			const dropIn = join(paths.systemdUserRoot, entry, RUNTIME_SYSTEMD_DROP_IN_FILE);
			if (desiredUser.has(unitName) || !isGeneratedSystemdFile(dropIn)) continue;
			files.add(dropIn);
			files.add(join(paths.systemdUserRoot, "default.target.wants", unitName));
			userUnits.add(unitName);
		}
	}
	const desiredEnvironmentFiles = new Set(
		[...desiredSystem, ...desiredUser].map((unit) => `${unit}.env`),
	);
	if (existsSync(paths.systemdEnvRoot)) {
		for (const entry of readdirSync(paths.systemdEnvRoot)) {
			if (!entry.endsWith(".service.env") || desiredEnvironmentFiles.has(entry)) continue;
			const path = join(paths.systemdEnvRoot, entry);
			if (!entry.startsWith("clawdi-") && !isGeneratedSystemdFile(path)) continue;
			files.add(path);
		}
	}
	return {
		files: [...files].sort(),
		systemUnits: [...systemUnits].sort(),
		userUnits: [...userUnits].sort(),
	};
}

export function removeStaleRuntimeSystemdFiles(
	paths: RuntimePaths,
	plan: RuntimeSystemdStaleFilePlan,
): string[] {
	const errors: string[] = [];
	for (const path of plan.files) {
		try {
			rmSync(path, { force: true });
			if (path.endsWith(`/${RUNTIME_SYSTEMD_DROP_IN_FILE}`) && existsSync(dirname(path))) {
				if (readdirSync(dirname(path)).length === 0) rmdirSync(dirname(path));
			}
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
	}
	const systemctl = process.env.CLAWDI_SYSTEMCTL_PATH?.trim() || "systemctl";
	if (plan.systemUnits.length > 0) {
		const result = spawnSync(systemctl, ["daemon-reload"], { encoding: "utf8" });
		if (result.status !== 0) errors.push("system systemd daemon-reload failed after stale file GC");
	}
	if (plan.userUnits.length > 0) {
		try {
			runRuntimeUserCommand(
				systemctl,
				["--user", "daemon-reload"],
				"",
				paths.userHome,
				paths.userHome,
			);
		} catch (error) {
			errors.push(
				`user systemd daemon-reload failed after stale file GC: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}
	return errors;
}

export function runtimeSystemdCommonEnvironment(paths: RuntimePaths): Record<string, string> {
	const environment: Record<string, string> = {
		HOME: paths.userHome,
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
	const args =
		isHermesDashboardProgram(program) && !program.args.includes("--skip-build")
			? [...program.args, "--skip-build"]
			: program.args;
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
			args,
			cwd: program.cwd,
			env,
		});
	}
	return writeSystemdUserUnit({
		paths: input.paths,
		name,
		description: `Clawdi hosted ${program.runtime}${program.service ? ` ${program.service}` : ""}`,
		command: program.command,
		args,
		cwd: program.cwd,
		env,
	});
}

function writeFileBrowserSystemdUnit(input: {
	program: RuntimeSystemdUserProgram;
	manifest: RuntimeManifest;
	paths: RuntimePaths;
}): string {
	const companion = input.manifest.companions?.filebrowser;
	if (!companion) throw new Error("Files systemd unit requires a companion manifest");
	return writeSystemdSystemUnit({
		paths: input.paths,
		name: "clawdi-files",
		description: "Clawdi hosted Files companion",
		command: input.program.command,
		args: input.program.args,
		execStart: fileBrowserSystemdExec(
			input.paths.fileBrowserServiceBinary,
			input.paths.fileBrowserConfig,
		),
		cwd: input.program.cwd,
		directoryKind: "file-browser",
		env: {
			HOME: "/nonexistent",
			CLAWDI_RUNTIME_REV: runtimeImpactRevision({
				companion: input.manifest.companions?.filebrowser ?? null,
			}),
		},
		extraUnitLines: ["After=network-online.target", "Wants=network-online.target"],
		extraServiceLines: [
			`User=${FILE_BROWSER_SERVICE_USER}`,
			`Group=${FILE_BROWSER_SERVICE_GROUP}`,
			// Publish only this verified executable into the component service's
			// private runtime directory; the platform state root stays untraversable.
			`BindReadOnlyPaths=${systemdPath(input.program.command)}:${systemdPath(input.paths.fileBrowserServiceBinary)}:norbind`,
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
			CLAWDI_RUNTIME_REV: runtimeSidecarProgramRevision(
				input.manifest,
				input.program,
				input.identity,
			),
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
	manifest: RuntimeManifest;
	paths: RuntimePaths;
	workspaceRoot: string;
	daemonAuthTokenFile: string | null;
	secretValues: Record<string, string> | undefined;
	providerProjectionRevisions: Partial<Record<string, string | null>>;
	runtimeRevision: Parameters<typeof runtimeSystemdProgramRevision>[4];
	commonEnvironment: Record<string, string>;
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
					CLAWDI_RUNTIME_REV: daemonProgramRevision(manifest),
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
				}),
			);
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

	return { systemUnits, userUnits, egressSidecarActive: shouldRunEgress, staleFiles };
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
