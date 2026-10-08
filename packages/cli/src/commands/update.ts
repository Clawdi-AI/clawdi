import { spawn, spawnSync } from "node:child_process";
import type { EventEmitter } from "node:events";
import {
	accessSync,
	closeSync,
	constants,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { delimiter, dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import chalk from "chalk";
import { emitJson, wantsJson } from "../lib/command-output";
import { getClawdiDir, getStoredConfig } from "../lib/config";
import {
	isDesktopManagedCurrentCli,
	isHomebrewManagedCurrentCli,
	resolveCurrentCliInvocation,
	resolveCurrentCliLayout,
} from "../lib/current-cli-invocation";
import { downloadAndStageNativeRelease } from "../lib/native-activation";
import type { NativeInstallOwnership } from "../lib/native-distribution";
import { nativeExecutableName, nativeReleaseBaseUrl } from "../lib/native-release-manifest";
import {
	type PrivateDirectoryLockOptions,
	PrivateDirectoryLockTimeoutError,
	withPrivateDirectoryLock,
} from "../lib/private-directory-lock";
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE, writePrivateFileAtomic } from "../lib/private-file";
import { terminateProcessGroup } from "../lib/process-group";
import { listRegisteredAgentTypes } from "../lib/select-adapter";
import { compareSemver, isValidSemver } from "../lib/semver";
import { getCliVersion } from "../lib/version";
import { evaluateHostPolicyForCommand } from "../runtime/host-policy";
import { detectRuntimeMode } from "../runtime/paths";
import type { RestartCoordination } from "../serve/auto-restart";
import { readHealth } from "../serve/installer";
import { log } from "../serve/log";
import { getServeStateDir } from "../serve/paths";

const REGISTRY_URL = "https://registry.npmjs.org/-/package/clawdi/dist-tags";
const MAX_REGISTRY_BYTES = 64 * 1024;
// Discovery stays hourly; automatic installs wait a day after local discovery.
export const AUTO_UPDATE_MIN_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_OBSERVED_VERSIONS = 8;
const CACHE_TTL_MS = 60 * 60 * 1000;
const DAEMON_UPDATE_INTERVAL_MS = 60 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 3 * 60_000;
const INSTALL_TERM_GRACE_MS = 2_000;
const INSTALL_KILL_GRACE_MS = 1_000;
export type Installer = "bun" | "npm";

export interface PackageManagerUpdateOwnership {
	kind: "package";
	installer: Installer;
	installerExecutable: string;
	executable: string;
}

export type UpdateOwnership = PackageManagerUpdateOwnership | NativeInstallOwnership;

interface ObservedVersion {
	version: string;
	firstSeenAt: string;
}

interface UpdateCache {
	checkedAt: string;
	latest: string;
	firstSeen: ObservedVersion[];
}

type BackgroundWorkerRequest = {
	current: string;
	logFd: number;
};

type AutoUpdateRuntime = {
	now?: () => number;
	detectOwnership?: () => UpdateOwnership | null;
	spawnBackgroundWorker?: (request: BackgroundWorkerRequest) => void;
};

type ForegroundUpdateRuntime = {
	now?: () => number;
	detectOwnership?: () => UpdateOwnership | null;
	isDesktopManaged?: () => boolean;
	isHomebrewManaged?: () => boolean;
	installRunner?: (command: string, args: string[]) => number | null;
	platform?: NodeJS.Platform;
	versionReader?: (command: string, args: string[]) => string | null;
	lockOptions?: PrivateDirectoryLockOptions;
	nativeReleaseBaseUrl?: string;
	nativeFetcher?: typeof fetch;
	nativeDownloadTimeoutMs?: number;
};

interface CommandVector {
	command: string;
	args: string[];
}

function cachePath(): string {
	return join(getClawdiDir(), "update.json");
}

function readCache(): UpdateCache | null {
	try {
		const parsed = JSON.parse(readFileSync(cachePath(), "utf-8")) as Partial<UpdateCache>;
		if (
			typeof parsed.checkedAt !== "string" ||
			!Number.isFinite(Date.parse(parsed.checkedAt)) ||
			typeof parsed.latest !== "string" ||
			!isValidSemver(parsed.latest)
		)
			return null;
		const firstSeen = Array.isArray(parsed.firstSeen)
			? parsed.firstSeen.filter(
					(entry): entry is ObservedVersion =>
						entry !== null &&
						typeof entry === "object" &&
						typeof entry.version === "string" &&
						isValidSemver(entry.version) &&
						typeof entry.firstSeenAt === "string" &&
						Number.isFinite(Date.parse(entry.firstSeenAt)),
				)
			: [];
		return { checkedAt: parsed.checkedAt, latest: parsed.latest, firstSeen };
	} catch {
		return null;
	}
}

function newestEligibleVersion(
	cache: UpdateCache | null,
	current: string,
	now: number,
): string | null {
	return (
		cache?.firstSeen
			.filter(
				({ version, firstSeenAt }) =>
					isNewer(version, current) && now - Date.parse(firstSeenAt) >= AUTO_UPDATE_MIN_AGE_MS,
			)
			.sort((a, b) => compareSemver(b.version, a.version))[0]?.version ?? null
	);
}

function writeCache(latest: string, now: number): UpdateCache {
	const firstSeen = readCache()?.firstSeen ?? [];
	if (!firstSeen.some((entry) => entry.version === latest)) {
		firstSeen.push({ version: latest, firstSeenAt: new Date(now).toISOString() });
	}
	firstSeen.sort((a, b) => compareSemver(b.version, a.version));
	// Keep the newest aged candidate even when many fresh releases arrive.
	const eligible = firstSeen.find(
		({ firstSeenAt }) => now - Date.parse(firstSeenAt) >= AUTO_UPDATE_MIN_AGE_MS,
	);
	// Preserve the oldest pending observation so a sustained release burst
	// cannot evict every version before any reaches the age threshold.
	const pending = firstSeen
		.filter(
			({ version, firstSeenAt }) =>
				(!eligible || isNewer(version, eligible.version)) &&
				now - Date.parse(firstSeenAt) < AUTO_UPDATE_MIN_AGE_MS,
		)
		.sort((a, b) => Date.parse(a.firstSeenAt) - Date.parse(b.firstSeenAt))[0];
	const anchors = firstSeen.filter((entry) => entry === eligible || entry === pending);
	const retained = firstSeen
		.filter((entry) => !anchors.includes(entry))
		.slice(0, MAX_OBSERVED_VERSIONS - anchors.length)
		.concat(anchors)
		.sort((a, b) => compareSemver(b.version, a.version));
	const cache = { checkedAt: new Date(now).toISOString(), latest, firstSeen: retained };
	try {
		writePrivateFileAtomic(cachePath(), `${JSON.stringify(cache, null, 2)}\n`, {
			mode: PRIVATE_FILE_MODE,
			dirMode: PRIVATE_DIR_MODE,
		});
	} catch {
		// Best-effort: a lost observation only delays a future automatic install.
	}
	return cache;
}

async function fetchLatest(timeoutMs = 3000): Promise<string | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(REGISTRY_URL, { signal: controller.signal });
		if (!res.ok || !res.body) return null;
		if (Number(res.headers.get("content-length")) > MAX_REGISTRY_BYTES) return null;
		const reader = res.body.getReader();
		const chunks: Uint8Array[] = [];
		let size = 0;
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				size += value.byteLength;
				if (size > MAX_REGISTRY_BYTES) return null;
				chunks.push(value);
			}
		} finally {
			await reader.cancel();
		}
		const data: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		if (!data || typeof data !== "object" || !("latest" in data)) return null;
		return typeof data.latest === "string" && isValidSemver(data.latest) ? data.latest : null;
	} catch {
		return null;
	} finally {
		controller.abort();
		clearTimeout(timer);
	}
}

function isNewer(latest: string, current: string): boolean {
	return isValidSemver(latest) && isValidSemver(current) && compareSemver(latest, current) > 0;
}

/**
 * Manual `clawdi update` — forces a registry fetch and, if a newer version
 * exists, installs it inline (foreground, blocking, with the installer's
 * own progress output). Pass `--check` to keep the old "diagnose only"
 * behavior. JSON / non-TTY runs stay diagnose-only unless `--yes` explicitly
 * authorizes installation.
 */
export async function update(
	opts: { json?: boolean; check?: boolean; yes?: boolean } = {},
	runtime: ForegroundUpdateRuntime = {},
) {
	const current = getCliVersion();
	const json = wantsJson(opts, { legacyImplicit: true });
	const managedBy = (runtime.isDesktopManaged ?? isDesktopManagedCurrentCli)()
		? "desktop"
		: (runtime.isHomebrewManaged ?? isHomebrewManagedCurrentCli)()
			? "homebrew"
			: null;
	if (managedBy) {
		if (json) {
			emitJson({ current, latest: null, upgradeAvailable: false, managedBy });
		} else {
			console.log(chalk.gray(`current:  ${current}`));
			console.log(
				chalk.cyan(
					managedBy === "desktop"
						? "Clawdi Desktop manages this command and its updates."
						: "Homebrew manages this command. Upgrade with: brew upgrade clawdi",
				),
			);
		}
		return;
	}
	const latest = await fetchLatest();

	if (!latest) {
		const message = `Could not reach ${REGISTRY_URL}`;
		if (json) {
			emitJson({ current, latest: null, error: { code: "registry_unreachable", message } });
		}
		console.error(message);
		process.exitCode = 1;
		return;
	}
	writeCache(latest, (runtime.now ?? Date.now)());
	const upgradeAvailable = isNewer(latest, current);
	const report = (installed: boolean) => {
		if (json) {
			emitJson({ current, latest, upgradeAvailable, installed });
		}
	};
	const print = json ? console.error : console.log;

	if (!json) {
		print(chalk.gray(`current:  ${current}`));
		print(chalk.gray(`latest:   ${latest}`));
	}

	if (!upgradeAvailable) {
		report(false);
		if (!json) print(chalk.green("\n✓ You're up to date."));
		return;
	}

	if (json && (!opts.yes || opts.check)) {
		report(false);
		console.error(`clawdi v${latest} is available. Re-run with --yes to install.`);
		return;
	}

	// `--check` keeps the old display-only behavior for users who scripted
	// against it (CI guards, custom dashboards). Default is now to install.
	if (opts.check) {
		const ownership = detectUpdateOwnership(runtime);
		console.log();
		if (ownership) {
			console.log(
				chalk.cyan("A newer version is available. Install with:") +
					"\n  " +
					chalk.white(
						ownership.kind === "native"
							? nativeInstallCommand(latest)
							: installCommand(ownership.installer, latest),
					),
			);
		} else {
			printUnsupportedInstall(latest);
		}
		return;
	}

	const ownership = detectUpdateOwnership(runtime);
	if (!ownership) {
		(json ? process.stderr : process.stdout).write("\n");
		printUnsupportedInstall(latest);
		report(false);
		return;
	}

	const owner = ownership.kind === "native" ? "native distribution" : ownership.installer;
	(json ? process.stderr : process.stdout).write("\n");
	print(chalk.cyan(`Installing v${latest} via ${owner}…`));
	const result = await runUpdateInstallWorker({
		current,
		latest,
		ownership,
		output: json ? "stderr" : "inherit",
		platform: runtime.platform,
		lockOptions: runtime.lockOptions,
		installRunner: runtime.installRunner
			? async (command, args) => runtime.installRunner?.(command, args) ?? null
			: undefined,
		versionReader: runtime.versionReader,
		nativeReleaseBaseUrl: runtime.nativeReleaseBaseUrl,
		nativeFetcher: runtime.nativeFetcher,
		nativeDownloadTimeoutMs: runtime.nativeDownloadTimeoutMs,
	});
	if (result.status === "locked") {
		process.stderr.write("\n");
		console.error(chalk.yellow("Another clawdi update is already running."));
		report(false);
		process.exitCode = 1;
		return;
	}
	if (result.status === "disabled") {
		process.stderr.write("\n");
		console.error(chalk.yellow("CLI updates are managed by this Cloud Agent's runtime."));
		report(false);
		process.exitCode = 1;
		return;
	}
	if (result.status === "no_update") {
		report(false);
		if (!json) print(chalk.gray("A newer CLI version is already installed."));
		return;
	}
	if (result.status === "failed") {
		process.stderr.write("\n");
		console.error(
			chalk.red(
				`${
					result.reason ??
					(result.installedVersion === undefined
						? `Install failed (${owner} exited ${result.exitCode}).`
						: `Install verification failed: expected ${latest}, got ${result.installedVersion ?? "no version"}.`)
				} Try manually:`,
			) +
				"\n  " +
				chalk.white(
					ownership.kind === "native"
						? nativeInstallCommand(latest)
						: installCommand(ownership.installer, latest),
				),
		);
		report(false);
		process.exitCode = result.exitCode ?? 1;
		return;
	}
	(json ? process.stderr : process.stdout).write("\n");
	print(chalk.green(`✓ clawdi v${latest} installed.`));
	report(true);
}

function printUnsupportedInstall(version: string): void {
	console.error(
		chalk.yellow("Automatic update is unsupported for this invocation.") +
			"\n" +
			chalk.gray("Update the installation that launched clawdi, or install the exact release:") +
			"\n  " +
			chalk.white(nativeInstallCommand(version)),
	);
}

const LAST_VERSION_FILE = "last-version";

function lastVersionPath(): string {
	return join(getClawdiDir(), LAST_VERSION_FILE);
}

function writeLastVersion(version: string): void {
	try {
		writePrivateFileAtomic(lastVersionPath(), `${version}\n`, {
			mode: PRIVATE_FILE_MODE,
			dirMode: PRIVATE_DIR_MODE,
		});
	} catch {
		// best-effort
	}
}

function detectUpdateOwnership(runtime: ForegroundUpdateRuntime): UpdateOwnership | null {
	return runtime.detectOwnership?.() ?? detectCurrentUpdateOwnership();
}

export function detectCurrentUpdateOwnership(): UpdateOwnership | null {
	let layout: ReturnType<typeof resolveCurrentCliLayout>;
	try {
		layout = resolveCurrentCliLayout();
	} catch {
		return null;
	}
	if (layout.kind === "native" && layout.nativeOwnership) return layout.nativeOwnership;
	let invokedPath: string | undefined;
	invokedPath = layout.kind === "script" ? layout.entryPath : undefined;
	for (const npmExecutable of absoluteExecutableCandidates("npm")) {
		const prefix = commandOutput(executableCommandVector(npmExecutable, ["prefix", "-g"]));
		const npmRoot = commandOutput(executableCommandVector(npmExecutable, ["root", "-g"]));
		const npmBin = prefix
			? process.platform === "win32"
				? normalizePath(prefix)
				: normalizePath(join(prefix, "bin"))
			: null;
		const ownership = detectPackageManagerUpdateOwnershipFromPaths(invokedPath, {
			npmBin,
			npmRoot,
			npmExecutable,
		});
		if (ownership) return ownership;
	}

	for (const bunExecutable of bunExecutableCandidates()) {
		const bunBin = commandOutput(executableCommandVector(bunExecutable, ["pm", "bin", "-g"]));
		const ownership = detectPackageManagerUpdateOwnershipFromPaths(invokedPath, {
			bunBin,
			bunRoot: bunBin ? bunGlobalRootDir(bunBin) : null,
			bunExecutable,
		});
		if (ownership) return ownership;
	}
	return null;
}

export type PackageManagerInstallPaths = {
	bunBin?: string | null;
	bunRoot?: string | null;
	bunExecutable?: string | null;
	npmBin?: string | null;
	npmRoot?: string | null;
	npmExecutable?: string | null;
};

export function detectPackageManagerUpdateOwnershipFromPaths(
	invokedPath: string | undefined,
	paths: PackageManagerInstallPaths,
): PackageManagerUpdateOwnership | null {
	if (!invokedPath) return null;

	const candidates = normalizedPathCandidates(invokedPath);
	const npmBin = paths.npmBin ? normalizePath(paths.npmBin) : null;
	const npmRoot = paths.npmRoot ? normalizePath(paths.npmRoot) : null;
	const npmExecutable = absolutePath(paths.npmExecutable);
	const bunBin = paths.bunBin ? normalizePath(paths.bunBin) : null;
	const bunRoot = paths.bunRoot ? normalizePath(paths.bunRoot) : null;
	const bunExecutable = absolutePath(paths.bunExecutable);
	if (candidates.some(isTransientPath)) return null;
	if (
		npmBin &&
		npmRoot &&
		npmExecutable &&
		candidates.some((candidate) => pathStartsWith(candidate, join(npmRoot, "clawdi")))
	) {
		return {
			kind: "package",
			installer: "npm",
			installerExecutable: npmExecutable,
			executable: globalExecutable("npm", npmBin),
		};
	}
	if (
		bunBin &&
		bunRoot &&
		bunExecutable &&
		candidates.some((candidate) => pathStartsWith(candidate, join(bunRoot, "clawdi")))
	) {
		return {
			kind: "package",
			installer: "bun",
			installerExecutable: bunExecutable,
			executable: globalExecutable("bun", bunBin),
		};
	}
	return null;
}

function absolutePath(path: string | null | undefined): string | null {
	return path && isAbsolute(path) ? normalizePath(path) : null;
}

function bunExecutableCandidates(): string[] {
	const candidates: string[] = [];
	const bunInstall = process.env.BUN_INSTALL;
	if (bunInstall) candidates.push(join(bunInstall, "bin", bunExecutableName()));
	const home = process.env.HOME;
	if (home) candidates.push(join(home, ".bun", "bin", bunExecutableName()));
	candidates.push(...absoluteExecutableCandidates("bun"));
	return verifiedAbsoluteExecutables(candidates);
}

function bunExecutableName(): string {
	return process.platform === "win32" ? "bun.exe" : "bun";
}

function absoluteExecutableCandidates(command: "bun" | "npm"): string[] {
	const names =
		process.platform === "win32"
			? command === "npm"
				? ["npm.cmd", "npm.exe", "npm"]
				: ["bun.exe", "bun"]
			: [command];
	const candidates = (process.env.PATH ?? "")
		.split(delimiter)
		.filter(Boolean)
		.flatMap((directory) => names.map((name) => join(directory, name)));
	return verifiedAbsoluteExecutables(candidates);
}

function verifiedAbsoluteExecutables(candidates: string[]): string[] {
	const verified: string[] = [];
	for (const candidate of candidates) {
		if (!isAbsolute(candidate)) continue;
		try {
			accessSync(candidate, constants.X_OK);
			verified.push(realpathSync(candidate));
		} catch {
			// Only an existing executable can own an installation.
		}
	}
	return [...new Set(verified)];
}

function bunGlobalRootDir(binDir: string): string {
	// Bun keeps global packages under the install root that owns
	// the authoritative `bun pm bin -g` directory.
	return normalizePath(join(dirname(binDir), "install", "global", "node_modules"));
}

function commandOutput(vector: CommandVector): string | null {
	try {
		const result = spawnSync(vector.command, vector.args, {
			encoding: "utf-8",
			windowsHide: true,
		});
		if (result.status !== 0) return null;
		const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
		return stdout || null;
	} catch {
		return null;
	}
}

function normalizedPathCandidates(path: string): string[] {
	const paths = [normalizePath(path)];
	try {
		paths.push(normalizePath(realpathSync(path)));
	} catch {
		// The executable path does not need to exist in tests or unusual launchers.
	}
	return [...new Set(paths)];
}

function normalizePath(path: string): string {
	return normalize(resolve(path));
}

function samePath(left: string, right: string): boolean {
	if (process.platform === "win32") {
		return normalizePath(left).toLowerCase() === normalizePath(right).toLowerCase();
	}
	return normalizePath(left) === normalizePath(right);
}

function pathStartsWith(path: string, parent: string): boolean {
	const normalizedPath = normalizePath(path);
	const normalizedParent = normalizePath(parent);
	if (samePath(normalizedPath, normalizedParent)) return true;
	const prefix = normalizedParent.endsWith(sep) ? normalizedParent : `${normalizedParent}${sep}`;
	if (process.platform === "win32") {
		return normalizedPath.toLowerCase().startsWith(prefix.toLowerCase());
	}
	return normalizedPath.startsWith(prefix);
}

function packageSpecForVersion(version: string): string {
	if (!isValidSemver(version)) throw new Error(`invalid clawdi update version: ${version}`);
	return `clawdi@${version}`;
}

function detectAutoUpdateOwnership(runtime: AutoUpdateRuntime): UpdateOwnership | null {
	return runtime.detectOwnership?.() ?? detectCurrentUpdateOwnership();
}

function installArgs(installer: Installer, version: string): string[] {
	const spec = packageSpecForVersion(version);
	return installer === "bun" ? ["add", "-g", spec] : ["i", "-g", spec];
}

export function installCommand(installer: Installer | null, version: string): string {
	const spec = packageSpecForVersion(version);
	return installer === "bun" ? `bun add -g ${spec}` : `npm i -g ${spec}`;
}

export function nativeInstallCommand(
	version?: string,
	platform: NodeJS.Platform = process.platform,
): string {
	if (version !== undefined && !isValidSemver(version))
		throw new Error(`invalid clawdi update version: ${version}`);
	if (platform === "win32") {
		return `${version === undefined ? "" : `$env:CLAWDI_VERSION='${version}'; `}irm https://clawdi.ai/install.ps1 | iex`;
	}
	if (version === undefined) return "curl -fsSL https://clawdi.ai/install.sh | sh";
	return `curl -fsSL https://github.com/Clawdi-AI/clawdi/releases/download/clawdi-cli-v${version}/install.sh | CLAWDI_VERSION=${version} sh`;
}

function isTransientInvocation(): boolean {
	return isTransientPath(process.argv[1] ?? "");
}

function isTransientPath(path: string): boolean {
	const normalized = path.replace(/\\/g, "/");
	return /\/_npx\/|\/bunx-[^/]+\/|\/\.bunx-|\/bun\/install\/cache\//.test(normalized);
}

function globalExecutable(installer: Installer, binDir: string): string {
	const extension = process.platform === "win32" ? (installer === "npm" ? ".cmd" : ".exe") : "";
	return join(binDir, `clawdi${extension}`);
}

function executableCommandVector(
	executable: string,
	args: string[],
	platform: NodeJS.Platform = process.platform,
): CommandVector {
	if (platform === "win32" && /\.(?:cmd|bat)$/i.test(executable)) {
		return {
			command: "cmd.exe",
			args: ["/d", "/s", "/c", executable, ...args],
		};
	}
	return { command: executable, args };
}

function readCommandVersion(command: string, args: string[]): string | null {
	try {
		const result = spawnSync(command, args, {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
			windowsHide: true,
		});
		if (result.status !== 0 || typeof result.stdout !== "string") return null;
		const version = result.stdout.trim();
		return isValidSemver(version) ? version : null;
	} catch {
		return null;
	}
}

function isLongLivedDaemonInvocation(args = process.argv.slice(2)): boolean {
	const commandIndex = args.findIndex((arg) => arg === "daemon");
	if (commandIndex < 0) return false;
	const rest = args.slice(commandIndex + 1);
	for (const arg of rest) {
		if (arg.startsWith("-")) continue;
		return arg === "run";
	}
	return true;
}

function isAutoUpdateControlInvocation(args = process.argv.slice(2)): boolean {
	const first = args.find((arg) => !arg.startsWith("-"));
	return first === "update" || first === "config";
}

function isInformationalInvocation(args = process.argv.slice(2)): boolean {
	return args.some(
		(arg) => arg === "--version" || arg === "-V" || arg === "--help" || arg === "-h",
	);
}

function isMachineReadableInvocation(args = process.argv.slice(2)): boolean {
	return args.includes("--json");
}

function outdatedDaemonAgents(current: string): string[] {
	try {
		const targets = listRegisteredAgentTypes();
		return targets.filter((agent) => {
			const health = readHealth(getServeStateDir(agent));
			if (!health.exists) return false;
			if (!health.version) return true;
			return isNewer(current, health.version);
		});
	} catch {
		return [];
	}
}

function autoUpdateDisabled(): boolean {
	if (process.env.CLAWDI_NO_AUTO_UPDATE) return true;
	if (process.env.CLAWDI_NO_UPDATE_CHECK) return true;
	if (isHomebrewManagedCurrentCli()) return true;
	if (isTransientInvocation()) return true;
	return getStoredConfig().autoUpdate === false;
}

async function latestFromCacheOrRegistry(
	now: () => number = Date.now,
): Promise<UpdateCache | null> {
	const cached = readCache();
	const age = cached ? now() - Date.parse(cached.checkedAt) : Infinity;
	if (cached && age >= 0 && age <= CACHE_TTL_MS) {
		// Old cache files have no observations; begin the gate conservatively.
		return cached.firstSeen.some(({ version }) => version === cached.latest)
			? cached
			: writeCache(cached.latest, now());
	}
	const latest = await fetchLatest();
	return latest ? writeCache(latest, now()) : cached;
}

type InstallerOutput = "inherit" | "stderr" | "log";

type ProcessInstallRunner = (
	command: string,
	args: string[],
	options: { signal?: AbortSignal; output: InstallerOutput },
) => Promise<number | null>;

export async function runInstallerProcess(
	command: string,
	args: string[],
	options: {
		signal?: AbortSignal;
		output?: InstallerOutput;
		timeoutMs?: number;
		termGraceMs?: number;
		killGraceMs?: number;
	} = {},
): Promise<number | null> {
	if (options.signal?.aborted) return null;
	const output = options.output ?? "log";
	const timeoutMs = options.timeoutMs ?? INSTALL_TIMEOUT_MS;
	const termGraceMs = options.termGraceMs ?? INSTALL_TERM_GRACE_MS;
	const killGraceMs = options.killGraceMs ?? INSTALL_KILL_GRACE_MS;
	if (
		!Number.isFinite(timeoutMs) ||
		timeoutMs <= 0 ||
		!Number.isFinite(termGraceMs) ||
		termGraceMs < 0 ||
		!Number.isFinite(killGraceMs) ||
		killGraceMs < 0
	) {
		throw new Error("installer timeout must be positive and grace periods must be non-negative");
	}
	const logPath = join(getClawdiDir(), "auto-update.log");
	let logFd: number;
	if (output === "log") {
		try {
			mkdirSync(getClawdiDir(), { recursive: true });
			logFd = openSync(logPath, "a");
		} catch {
			logFd = -1;
		}
	} else {
		logFd = -1;
	}
	try {
		return await new Promise<number | null>((resolve) => {
			const child = spawn(command, args, {
				stdio:
					output === "inherit"
						? "inherit"
						: output === "stderr"
							? ["ignore", process.stderr, process.stderr]
							: logFd >= 0
								? ["ignore", logFd, logFd]
								: "ignore",
				env: process.env,
				detached: process.platform !== "win32",
				windowsHide: true,
			});
			const processEvents: EventEmitter = process;
			let markClosed = () => {};
			const closed = new Promise<void>((resolveClosed) => {
				markClosed = resolveClosed;
			});
			let termination: Promise<void> | null = null;
			let settled = false;
			const finish = (result: number | null) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				options.signal?.removeEventListener("abort", terminate);
				processEvents.removeListener("SIGINT", terminate);
				processEvents.removeListener("SIGTERM", terminate);
				resolve(result);
			};
			function terminate() {
				if (termination || settled) return;
				termination = terminateProcessGroup(child, closed, {
					termTimeoutMs: termGraceMs,
					killTimeoutMs: killGraceMs,
				}).then(() => finish(null));
			}
			const timeout = setTimeout(terminate, timeoutMs);
			options.signal?.addEventListener("abort", terminate, { once: true });
			processEvents.once("SIGINT", terminate);
			processEvents.once("SIGTERM", terminate);
			if (options.signal?.aborted) terminate();
			child.on("error", () => {
				markClosed();
				finish(null);
			});
			child.on("close", (code) => {
				markClosed();
				if (!termination) finish(code);
			});
		});
	} finally {
		if (logFd >= 0) {
			try {
				closeSync(logFd);
			} catch {
				// best-effort
			}
		}
	}
}

type UpdateInstallWorkerResult =
	| { status: "installed"; installedVersion: string }
	| { status: "failed"; exitCode: number | null; installedVersion?: undefined; reason?: string }
	| { status: "failed"; exitCode?: undefined; installedVersion: string | null; reason?: string }
	| { status: "locked" }
	| { status: "disabled" }
	| { status: "no_update" };

async function runUpdateInstallWorker(input: {
	automatic?: boolean;
	current: string;
	latest: string;
	ownership: UpdateOwnership;
	output: InstallerOutput;
	signal?: AbortSignal;
	platform?: NodeJS.Platform;
	lockOptions?: PrivateDirectoryLockOptions;
	installRunner?: ProcessInstallRunner;
	versionReader?: (command: string, args: string[]) => string | null;
	nativeReleaseBaseUrl?: string;
	nativeFetcher?: typeof fetch;
	nativeDownloadTimeoutMs?: number;
}): Promise<UpdateInstallWorkerResult> {
	if (!evaluateHostPolicyForCommand("update").allowed) return { status: "disabled" };
	if (input.signal?.aborted) return { status: "failed", exitCode: null };
	if (input.ownership.kind === "native") {
		return await runNativeUpdateInstall({ ...input, ownership: input.ownership });
	}
	const install = executableCommandVector(
		input.ownership.installerExecutable,
		installArgs(input.ownership.installer, input.latest),
		input.platform,
	);
	const smoke = executableCommandVector(input.ownership.executable, ["--version"], input.platform);
	try {
		return await withPrivateDirectoryLock(
			join(getClawdiDir(), "update.lock"),
			async (lease) => {
				// A manual update may have completed since this worker discovered its
				// candidate. Package installs read the current package.json on disk.
				if (input.automatic && !isNewer(input.latest, getCliVersion())) {
					return { status: "no_update" };
				}
				const exitCode = await (input.installRunner ?? runInstallerProcess)(
					install.command,
					install.args,
					{ signal: input.signal, output: input.output },
				);
				lease.assertOwned();
				if (exitCode !== 0) return { status: "failed", exitCode };
				const installedVersion = (input.versionReader ?? readCommandVersion)(
					smoke.command,
					smoke.args,
				);
				lease.assertOwned();
				if (installedVersion !== input.latest) {
					return { status: "failed", installedVersion };
				}
				writeLastVersion(input.current);
				lease.assertOwned();
				return { status: "installed", installedVersion };
			},
			input.lockOptions,
		);
	} catch (error) {
		if (error instanceof PrivateDirectoryLockTimeoutError) return { status: "locked" };
		throw error;
	}
}

async function runNativeUpdateInstall(input: {
	automatic?: boolean;
	current: string;
	latest: string;
	ownership: NativeInstallOwnership;
	output: InstallerOutput;
	signal?: AbortSignal;
	lockOptions?: PrivateDirectoryLockOptions;
	nativeReleaseBaseUrl?: string;
	nativeFetcher?: typeof fetch;
	nativeDownloadTimeoutMs?: number;
}): Promise<UpdateInstallWorkerResult> {
	let stageDir: string | null = null;
	try {
		let staged: Awaited<ReturnType<typeof downloadAndStageNativeRelease>>;
		try {
			staged = await downloadAndStageNativeRelease({
				prefix: input.ownership.prefix,
				version: input.latest,
				target: input.ownership.target,
				releaseBaseUrl: input.nativeReleaseBaseUrl ?? nativeReleaseBaseUrl(input.latest),
				signal: input.signal,
				fetcher: input.nativeFetcher,
				timeoutMs: input.nativeDownloadTimeoutMs,
			});
		} catch (error) {
			return { status: "failed", exitCode: null, reason: nativeStagingFailureReason(error) };
		}
		stageDir = staged.stageDir;
		const activationArgs = [
			"update",
			"--native-activate",
			...(input.automatic ? ["--native-auto-update"] : []),
			"--native-stage",
			staged.stageDir,
			"--native-prefix",
			input.ownership.prefix,
			"--native-version",
			input.latest,
			"--native-target",
			input.ownership.target,
			...(input.lockOptions?.timeoutMs !== undefined
				? ["--native-lock-timeout-ms", String(input.lockOptions.timeoutMs)]
				: []),
		];
		const exitCode = await runInstallerProcess(
			join(staged.stageDir, nativeExecutableName(staged.target)),
			activationArgs,
			{
				signal: input.signal,
				output: input.output,
			},
		);
		if (exitCode === 75) return { status: "locked" };
		if (exitCode === 76) return { status: "no_update" };
		if (exitCode !== 0) {
			return {
				status: "failed",
				exitCode,
				reason: "Native activation did not complete; inspect the stable launcher and retry.",
			};
		}
		stageDir = null;
		writeLastVersion(input.current);
		return { status: "installed", installedVersion: input.latest };
	} catch (error) {
		return { status: "failed", exitCode: null, reason: nativeStagingFailureReason(error) };
	} finally {
		if (stageDir) rmSync(stageDir, { recursive: true, force: true });
	}
}

function nativeStagingFailureReason(error: unknown): string {
	const message = error instanceof Error ? error.message : "";
	if (/timed out/i.test(message)) return "Native release download timed out.";
	if (error instanceof DOMException && error.name === "AbortError")
		return "Native update was canceled.";
	if (/abort|cancel/i.test(message)) return "Native update was canceled.";
	if (message === "native manifest unreachable") {
		return "Could not reach the native release manifest. Check your network and retry.";
	}
	const downloadFailure = /^native (manifest|artifact) download failed \(([0-9]{3})\)$/.exec(
		message,
	);
	if (downloadFailure) {
		return `Native release ${downloadFailure[1]} download failed (${downloadFailure[2]}).`;
	}
	if (/checksum mismatch/.test(message)) return "Native release checksum verification failed.";
	if (
		/maximum allowed size|size limit|too many entries|unsafe entry|duplicate entry/.test(message)
	) {
		return "Native release archive failed safety validation.";
	}
	if (/manifest/.test(message)) return "Native release manifest validation failed.";
	return "Native release staging failed.";
}

export type DaemonAutoUpdateResult =
	| "disabled"
	| "no_update"
	| "unsupported"
	| "locked"
	| "installed"
	| "failed";

type DaemonInstallRunner = (
	installer: Installer,
	args: string[],
	signal?: AbortSignal,
) => Promise<number | null>;

export async function daemonAutoUpdateOnce(
	opts: {
		currentVersion?: string;
		now?: () => number;
		ownership?: UpdateOwnership | null;
		installRunner?: DaemonInstallRunner;
		versionReader?: (executable: string) => string | null;
		ignoreDisabled?: boolean;
		restartCoordination?: RestartCoordination;
		signal?: AbortSignal;
	} = {},
): Promise<DaemonAutoUpdateResult> {
	if (!evaluateHostPolicyForCommand("update").allowed) return "disabled";
	if (!opts.ignoreDisabled && autoUpdateDisabled()) return "disabled";
	if (opts.signal?.aborted) return "disabled";

	const current = opts.currentVersion ?? getCliVersion();
	const now = opts.now ?? Date.now;
	const latest = newestEligibleVersion(await latestFromCacheOrRegistry(now), current, now());
	if (!latest || !isNewer(latest, current)) return "no_update";

	const ownership = opts.ownership === undefined ? detectCurrentUpdateOwnership() : opts.ownership;
	if (!ownership) {
		log.warn("daemon.auto_update_unsupported", { current, latest });
		return "unsupported";
	}
	const owner = ownership.kind === "native" ? "native" : ownership.installer;
	log.info("daemon.auto_update_installing", { current, latest, owner });
	const installAndValidate = async (): Promise<DaemonAutoUpdateResult> => {
		const result = await runUpdateInstallWorker({
			automatic: true,
			current,
			latest,
			ownership,
			output: "log",
			signal: opts.signal,
			lockOptions: { timeoutMs: 0 },
			installRunner:
				ownership.kind === "package" && opts.installRunner
					? async (_command, _args, options) =>
							opts.installRunner?.(
								ownership.installer,
								installArgs(ownership.installer, latest),
								options.signal,
							) ?? null
					: undefined,
			versionReader: opts.versionReader
				? () =>
						opts.versionReader?.(
							ownership.kind === "native" ? ownership.launcher : ownership.executable,
						) ?? null
				: undefined,
		});
		if (result.status === "no_update") return "no_update";
		if (result.status === "locked") return "locked";
		if (result.status === "disabled") return "disabled";
		if (result.status === "failed") {
			if (result.reason) {
				log.warn("daemon.auto_update_failed", {
					current,
					latest,
					owner,
					reason: result.reason,
				});
				return "failed";
			}
			if (result.installedVersion !== undefined) {
				log.warn("daemon.auto_update_validation_failed", {
					current,
					latest,
					owner,
					installed_version: result.installedVersion,
				});
			} else {
				log.warn("daemon.auto_update_failed", {
					current,
					latest,
					owner,
					status: result.exitCode,
				});
			}
			return "failed";
		}
		log.info("daemon.auto_update_installed", { from: current, to: latest, owner });
		return "installed";
	};
	return opts.restartCoordination
		? await opts.restartCoordination.duringUpdateInstall(installAndValidate)
		: await installAndValidate();
}

export function startDaemonAutoUpdate(opts: {
	abort: AbortController;
	restart: RestartCoordination;
	intervalMs?: number;
	initialDelayMs?: number;
}): boolean {
	if (!evaluateHostPolicyForCommand("update").allowed) return false;
	if (autoUpdateDisabled()) return false;
	const intervalMs = opts.intervalMs ?? DAEMON_UPDATE_INTERVAL_MS;
	const initialDelayMs =
		opts.initialDelayMs ?? Math.min(5 * 60_000, intervalMs) + Math.floor(Math.random() * 60_000);

	void (async () => {
		await sleep(initialDelayMs, opts.abort.signal);
		while (!opts.abort.signal.aborted) {
			const result = await daemonAutoUpdateOnce({
				restartCoordination: opts.restart,
				signal: opts.abort.signal,
			});
			if (result === "installed") {
				opts.restart.requestRestart();
				return;
			}
			await sleep(intervalMs, opts.abort.signal);
		}
	})().catch((e) => {
		log.warn("daemon.auto_update_loop_failed", {
			error: e instanceof Error ? e.message : String(e),
		});
	});
	return true;
}

/**
 * Default-on auto-updater. On startup:
 *   1. If the binary version differs from `last-version` on disk, print a
 *      one-line "updated to v…" notice (the previous run's spawn finished).
 *   2. If a newer release has been observed for at least 24 hours, install it
 *      in the background so the next invocation gets it.
 *
 * Opt-out: `CLAWDI_NO_AUTO_UPDATE=1` env, `clawdi config set autoUpdate
 * false`, non-TTY (CI), or running via npx/bunx.
 */
export async function maybeAutoUpdate(runtime: AutoUpdateRuntime = {}): Promise<void> {
	if (detectRuntimeMode() === "hosted") return;
	if (isHomebrewManagedCurrentCli()) return;
	if (
		isLongLivedDaemonInvocation() ||
		isAutoUpdateControlInvocation() ||
		isInformationalInvocation() ||
		isMachineReadableInvocation()
	) {
		return;
	}
	const current = getCliVersion();
	const isHumanTerminal = !!process.stdout.isTTY;

	// Notify when this CLI is newer than the last version seen. Scripted and
	// JSON invocations return above so their stdout remains machine-readable.
	const lastFile = lastVersionPath();
	try {
		if (existsSync(lastFile)) {
			const last = readFileSync(lastFile, "utf-8").trim();
			if (isHumanTerminal && last && last !== current && isNewer(current, last)) {
				console.log(
					`${chalk.green("✓")} ${chalk.gray(`Updated clawdi to v${current} (was v${last})`)}`,
				);
				const outdatedDaemons = outdatedDaemonAgents(current);
				if (outdatedDaemons.length > 0) {
					console.log(chalk.gray("  Restart the daemon to pick it up: clawdi daemon restart"));
				}
			}
		}
	} catch {
		// best-effort
	}
	writeLastVersion(current);

	if (process.env.CLAWDI_NO_AUTO_UPDATE) return;
	if (process.env.CLAWDI_NO_UPDATE_CHECK) return;
	if (!isHumanTerminal) return;
	if (isTransientInvocation()) return;

	if (getStoredConfig().autoUpdate === false) return;

	const cached = readCache();
	const now = (runtime.now ?? Date.now)();
	const cacheAge = cached ? now - Date.parse(cached.checkedAt) : Infinity;
	const cacheFresh = cacheAge >= 0 && cacheAge <= CACHE_TTL_MS;
	const latest = newestEligibleVersion(cached, current, now);
	if (cacheFresh && !latest) return;
	if (!detectAutoUpdateOwnership(runtime)) return;

	// Redirect installer output to a logfile so silent failures (network
	// flake, perms error, npm 4xx) leave a trail. `stdio: "ignore"` would
	// throw the diagnosis away. Append (`"a"`) instead of truncate (`"w"`)
	// so concurrent discovery workers do not clobber each other's diagnostics.
	const logPath = join(getClawdiDir(), "auto-update.log");
	let logFd: number;
	try {
		mkdirSync(getClawdiDir(), { recursive: true });
		logFd = openSync(logPath, "a");
	} catch {
		// Fall back to ignore — best-effort. The install can still succeed.
		logFd = -1;
	}

	if (latest) {
		console.log(chalk.gray(`Updating clawdi v${current} → v${latest} in background…`));
	}
	try {
		const spawner = runtime.spawnBackgroundWorker ?? spawnBackgroundUpdateWorker;
		spawner({ current, logFd });
	} finally {
		if (logFd >= 0) {
			try {
				closeSync(logFd);
			} catch {
				// best-effort
			}
		}
	}
}

function spawnBackgroundUpdateWorker(request: BackgroundWorkerRequest): void {
	let invocation: ReturnType<typeof resolveCurrentCliInvocation>;
	try {
		invocation = resolveCurrentCliInvocation([
			"update",
			"--background-worker",
			"--current-version",
			request.current,
		]);
	} catch {
		return;
	}
	const child = spawn(invocation.command, invocation.args, {
		stdio: request.logFd >= 0 ? ["ignore", request.logFd, request.logFd] : "ignore",
		detached: true,
		env: process.env,
		windowsHide: true,
	});
	child.on("error", () => {
		// Installer missing / crashed — silent skip; the user still sees
		// `auto-update.log` if they care, and the next invocation retries.
	});
	child.unref();
}

export async function runBackgroundUpdateWorker(
	opts: {
		currentVersion: string;
	},
	runtime: {
		now?: () => number;
		ownership?: UpdateOwnership | null;
		installRunner?: DaemonInstallRunner;
		versionReader?: (executable: string) => string | null;
		lockOptions?: PrivateDirectoryLockOptions;
	} = {},
): Promise<DaemonAutoUpdateResult> {
	if (detectRuntimeMode() === "hosted") return "disabled";
	if (autoUpdateDisabled()) return "disabled";
	if (!isValidSemver(opts.currentVersion)) return "failed";
	const running = getCliVersion();
	const current = isNewer(running, opts.currentVersion) ? running : opts.currentVersion;
	const now = runtime.now ?? Date.now;
	const latest = newestEligibleVersion(await latestFromCacheOrRegistry(now), current, now());
	if (!latest || !isValidSemver(latest) || !isNewer(latest, current)) {
		return "no_update";
	}
	const ownership =
		runtime.ownership === undefined ? detectCurrentUpdateOwnership() : runtime.ownership;
	if (!ownership) return "unsupported";
	const result = await runUpdateInstallWorker({
		automatic: true,
		current,
		latest,
		ownership,
		output: "log",
		lockOptions: runtime.lockOptions ?? { timeoutMs: 0 },
		installRunner:
			ownership.kind === "package" && runtime.installRunner
				? async (_command, _args, options) =>
						runtime.installRunner?.(
							ownership.installer,
							installArgs(ownership.installer, latest),
							options.signal,
						) ?? null
				: undefined,
		versionReader: runtime.versionReader
			? () =>
					runtime.versionReader?.(
						ownership.kind === "native" ? ownership.launcher : ownership.executable,
					) ?? null
			: undefined,
	});
	return result.status === "no_update"
		? "no_update"
		: result.status === "installed"
			? "installed"
			: result.status === "locked"
				? "locked"
				: result.status === "disabled"
					? "disabled"
					: "failed";
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		const onAbort = () => {
			clearTimeout(t);
			resolve();
		};
		const t = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
