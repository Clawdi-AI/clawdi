import { spawn, spawnSync } from "node:child_process";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, normalize, resolve, sep } from "node:path";
import chalk from "chalk";
import { getClawdiDir, getStoredConfig } from "../lib/config";
import { listRegisteredAgentTypes } from "../lib/select-adapter";
import { compareSemver, isValidSemver } from "../lib/semver";
import { getCliVersion } from "../lib/version";
import { evaluateHostPolicyForCommand } from "../runtime/host-policy";
import { detectRuntimeMode } from "../runtime/paths";
import type { RestartCoordination } from "../serve/auto-restart";
import { isSingletonDaemonInstalled, listInstalledAgents, readHealth } from "../serve/installer";
import { log } from "../serve/log";
import { getServeStateDir } from "../serve/paths";

const REGISTRY_URL = "https://registry.npmjs.org/clawdi";
// 1 hour: short enough that a fresh release reaches users within an hour of
// publication, long enough that we don't hammer the npm registry on every
// CLI invocation. Originally 24h — that meant a new release could sit
// invisible to active users for a full day, which made `--auto-update`
// feel broken whenever a fix shipped.
const CACHE_TTL_MS = 60 * 60 * 1000;
const DAEMON_UPDATE_INTERVAL_MS = 60 * 60 * 1000;
const DAEMON_UPDATE_LOCK_STALE_MS = 15 * 60 * 1000;
export type Installer = "bun" | "npm";

interface GlobalInstallOwnership {
	installer: Installer;
	executable: string;
}

interface UpdateCache {
	checkedAt: string;
	latest: string;
}

type BackgroundInstallContext = {
	current: string;
	latest: string;
	logFd: number;
};

type AutoUpdateRuntime = {
	detectOwnership?: () => GlobalInstallOwnership | null;
	spawnBackgroundInstall?: (
		installer: Installer,
		args: string[],
		context: BackgroundInstallContext,
	) => void;
};

type ForegroundUpdateRuntime = {
	detectOwnership?: () => GlobalInstallOwnership | null;
	installRunner?: (command: string, args: string[]) => number | null;
	platform?: NodeJS.Platform;
	versionReader?: (command: string, args: string[]) => string | null;
};

interface CommandVector {
	command: string;
	args: string[];
}

function cachePath(channel = "latest"): string {
	return join(getClawdiDir(), channel === "latest" ? "update.json" : `update-${channel}.json`);
}

function readCache(channel = "latest"): UpdateCache | null {
	try {
		const p = cachePath(channel);
		if (!existsSync(p)) return null;
		const parsed = JSON.parse(readFileSync(p, "utf-8")) as Partial<UpdateCache>;
		const latest = parsed.latest;
		if (typeof parsed.checkedAt !== "string" || typeof latest !== "string") {
			return null;
		}
		if (!isValidSemver(latest)) return null;
		return { checkedAt: parsed.checkedAt, latest };
	} catch {
		return null;
	}
}

function writeCache(latest: string, channel = "latest"): void {
	try {
		mkdirSync(getClawdiDir(), { recursive: true });
		writeFileSync(
			cachePath(channel),
			`${JSON.stringify({ checkedAt: new Date().toISOString(), latest }, null, 2)}\n`,
			{ mode: 0o600 },
		);
	} catch {
		// best-effort; ignore
	}
}

function updateChannelForVersion(version: string): string {
	if (!isValidSemver(version)) return "latest";
	return version.split("+", 1)[0]?.includes("-") ? "beta" : "latest";
}

async function fetchLatest(timeoutMs = 3000, channel = "latest"): Promise<string | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(REGISTRY_URL, { signal: controller.signal });
		if (!res.ok) return null;
		const data = (await res.json()) as { "dist-tags"?: Record<string, string | undefined> };
		const resolved = data["dist-tags"]?.[channel];
		return resolved && isValidSemver(resolved) ? resolved : null;
	} catch {
		return null;
	} finally {
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
 * behavior. JSON / non-TTY runs always stay diagnose-only because piping
 * into a script and silently mutating the global install would surprise.
 */
export async function update(
	opts: { json?: boolean; check?: boolean } = {},
	runtime: ForegroundUpdateRuntime = {},
) {
	const current = getCliVersion();
	const channel = updateChannelForVersion(current);
	const latest = await fetchLatest(3000, channel);

	if (latest) writeCache(latest, channel);

	if (opts.json || !process.stdout.isTTY) {
		console.log(
			JSON.stringify(
				{
					current,
					latest,
					upgradeAvailable: latest ? isNewer(latest, current) : false,
				},
				null,
				2,
			),
		);
		return;
	}

	if (!latest) {
		console.log(chalk.yellow(`Could not reach npm registry at ${REGISTRY_URL}`));
		return;
	}

	console.log(chalk.gray(`current:  ${current}`));
	console.log(chalk.gray(`latest:   ${latest}`));

	if (!isNewer(latest, current)) {
		console.log(chalk.green("\n✓ You're up to date."));
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
					chalk.white(installCommand(ownership.installer, latest)),
			);
		} else {
			printUnsupportedInstall(latest);
		}
		return;
	}

	const ownership = detectUpdateOwnership(runtime);
	if (!ownership) {
		console.log();
		printUnsupportedInstall(latest);
		return;
	}

	const { installer } = ownership;
	const args = installArgs(installer, latest);
	const install = installerCommandVector(installer, args, runtime.platform);
	console.log();
	console.log(chalk.cyan(`Installing v${latest} via ${installer}…`));
	const status = (runtime.installRunner ?? runForegroundInstall)(install.command, install.args);
	if (status !== 0) {
		console.log();
		console.log(
			chalk.red(`Install failed (${installer} exited ${status}). Try manually:`) +
				"\n  " +
				chalk.white(installCommand(installer, latest)),
		);
		process.exitCode = status ?? 1;
		return;
	}
	const smoke = executableCommandVector(ownership.executable, ["--version"], runtime.platform);
	const installedVersion = (runtime.versionReader ?? readCommandVersion)(smoke.command, smoke.args);
	if (installedVersion !== latest) {
		console.log();
		console.log(
			chalk.red(
				`Install verification failed: expected ${latest}, got ${installedVersion ?? "no version"}.`,
			),
		);
		process.exitCode = 1;
		return;
	}
	writeLastVersion(current);
	console.log();
	console.log(chalk.green(`✓ clawdi v${latest} installed.`));
}

function printUnsupportedInstall(version: string): void {
	console.log(
		chalk.yellow("Automatic update is unsupported for this invocation.") +
			"\n" +
			chalk.gray("Update the installation that launched clawdi, or install the exact release:") +
			"\n  " +
			chalk.white(installCommand(null, version)),
	);
}

const LAST_VERSION_FILE = "last-version";

function lastVersionPath(): string {
	return join(getClawdiDir(), LAST_VERSION_FILE);
}

function writeLastVersion(version: string): void {
	try {
		mkdirSync(getClawdiDir(), { recursive: true });
		writeFileSync(lastVersionPath(), version, { mode: 0o644 });
	} catch {
		// best-effort
	}
}

export function detectInstaller(): Installer | null {
	return detectGlobalInstall()?.installer ?? null;
}

function detectUpdateOwnership(runtime: ForegroundUpdateRuntime): GlobalInstallOwnership | null {
	return runtime.detectOwnership?.() ?? detectGlobalInstall();
}

function detectGlobalInstall(): GlobalInstallOwnership | null {
	const bunBin = bunGlobalBinDir();
	return detectGlobalInstallFromPaths(process.argv[1], {
		npmBin: npmGlobalBinDir(),
		npmRoot: npmGlobalRootDir(),
		bunBin,
		bunRoot: bunBin ? bunGlobalRootDir(bunBin) : null,
	});
}

export function detectInstallerFromPaths(
	invokedPath: string | undefined,
	paths: {
		bunBin?: string | null;
		bunRoot?: string | null;
		npmBin?: string | null;
		npmRoot?: string | null;
	},
): Installer | null {
	return detectGlobalInstallFromPaths(invokedPath, paths)?.installer ?? null;
}

function detectGlobalInstallFromPaths(
	invokedPath: string | undefined,
	paths: {
		bunBin?: string | null;
		bunRoot?: string | null;
		npmBin?: string | null;
		npmRoot?: string | null;
	},
): GlobalInstallOwnership | null {
	if (!invokedPath) return null;

	const candidates = normalizedPathCandidates(invokedPath);
	const npmBin = paths.npmBin ? normalizePath(paths.npmBin) : null;
	const npmRoot = paths.npmRoot ? normalizePath(paths.npmRoot) : null;
	const bunBin = paths.bunBin ? normalizePath(paths.bunBin) : null;
	const bunRoot = paths.bunRoot ? normalizePath(paths.bunRoot) : null;
	if (candidates.some(isTransientPath)) return null;
	if (
		npmBin &&
		npmRoot &&
		candidates.some((candidate) => pathStartsWith(candidate, join(npmRoot, "clawdi")))
	) {
		return { installer: "npm", executable: globalExecutable("npm", npmBin) };
	}
	if (
		bunBin &&
		bunRoot &&
		candidates.some((candidate) => pathStartsWith(candidate, join(bunRoot, "clawdi")))
	) {
		return { installer: "bun", executable: globalExecutable("bun", bunBin) };
	}
	return null;
}

function npmGlobalBinDir(): string | null {
	const prefix = commandOutput(installerCommandVector("npm", ["prefix", "-g"]));
	if (!prefix) return null;
	return process.platform === "win32" ? normalizePath(prefix) : normalizePath(join(prefix, "bin"));
}

function npmGlobalRootDir(): string | null {
	const root = commandOutput(installerCommandVector("npm", ["root", "-g"]));
	return root ? normalizePath(root) : null;
}

function bunGlobalBinDir(): string | null {
	const bin = commandOutput(executableCommandVector("bun", ["pm", "bin", "-g"]));
	return bin ? normalizePath(bin) : null;
}

function bunGlobalRootDir(binDir: string): string {
	// Bun 1.3.14 keeps global packages under the install root that owns
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

function detectAutoUpdateOwnership(runtime: AutoUpdateRuntime): GlobalInstallOwnership | null {
	return runtime.detectOwnership?.() ?? detectGlobalInstall();
}

function packageSpecForVersion(version: string): string {
	if (!isValidSemver(version)) throw new Error(`invalid clawdi update version: ${version}`);
	return `clawdi@${version}`;
}

function installArgs(installer: Installer, version: string): string[] {
	const spec = packageSpecForVersion(version);
	return installer === "bun" ? ["add", "-g", spec] : ["i", "-g", spec];
}

export function installCommand(installer: Installer | null, version: string): string {
	const spec = packageSpecForVersion(version);
	return installer === "bun" ? `bun add -g ${spec}` : `npm i -g ${spec}`;
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

function installerCommandVector(
	installer: Installer,
	args: string[],
	platform: NodeJS.Platform = process.platform,
): CommandVector {
	const executable = installer === "npm" && platform === "win32" ? "npm.cmd" : installer;
	return executableCommandVector(executable, args, platform);
}

function runForegroundInstall(command: string, args: string[]): number | null {
	try {
		return spawnSync(command, args, {
			stdio: "inherit",
			windowsHide: true,
		}).status;
	} catch {
		return null;
	}
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

function readExecutableVersion(executable: string): string | null {
	const vector = executableCommandVector(executable, ["--version"]);
	return readCommandVersion(vector.command, vector.args);
}

function isLongLivedDaemonInvocation(args = process.argv.slice(2)): boolean {
	const commandIndex = args.findIndex((arg) => arg === "daemon" || arg === "serve");
	if (commandIndex < 0) return false;
	const rest = args.slice(commandIndex + 1);
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i];
		if (arg === "--agent" || arg === "--environment-id") {
			i += 1;
			continue;
		}
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
		const targets = isSingletonDaemonInstalled()
			? listRegisteredAgentTypes()
			: listInstalledAgents();
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
	if (isTransientInvocation()) return true;
	const stored = getStoredConfig() as { autoUpdate?: unknown };
	return stored.autoUpdate === false || stored.autoUpdate === "false";
}

async function latestFromCacheOrRegistry(channel = "latest"): Promise<string | null> {
	const cached = readCache(channel);
	const now = Date.now();
	if (cached && now - new Date(cached.checkedAt).getTime() <= CACHE_TTL_MS) {
		return cached.latest;
	}
	const latest = await fetchLatest(3000, channel);
	if (latest) {
		writeCache(latest, channel);
		return latest;
	}
	return cached?.latest ?? null;
}

function acquireDaemonUpdateLock(): (() => void) | null {
	const root = getClawdiDir();
	const lockDir = join(root, "daemon-auto-update.lock");
	const acquire = () => {
		mkdirSync(root, { recursive: true });
		mkdirSync(lockDir, { mode: 0o700 });
		writeFileSync(join(lockDir, "pid"), `${process.pid}\n`, { mode: 0o600 });
		return () => {
			rmSync(lockDir, { recursive: true, force: true });
		};
	};
	try {
		return acquire();
	} catch {
		try {
			const age = Date.now() - statSync(lockDir).mtimeMs;
			if (age > DAEMON_UPDATE_LOCK_STALE_MS) {
				rmSync(lockDir, { recursive: true, force: true });
				return acquire();
			}
		} catch {
			// If stat/remove failed, treat as locked; another daemon
			// will retry on the next cadence.
		}
		return null;
	}
}

type InstallRunner = (
	installer: Installer,
	args: string[],
	signal?: AbortSignal,
) => Promise<number | null>;

async function runInstall(installer: Installer, args: string[], signal?: AbortSignal) {
	if (signal?.aborted) return null;

	const logPath = join(getClawdiDir(), "auto-update.log");
	let logFd: number;
	try {
		mkdirSync(getClawdiDir(), { recursive: true });
		logFd = openSync(logPath, "a");
	} catch {
		logFd = -1;
	}
	try {
		return await new Promise<number | null>((resolve) => {
			const vector = installerCommandVector(installer, args);
			const child = spawn(vector.command, vector.args, {
				stdio: logFd >= 0 ? ["ignore", logFd, logFd] : "ignore",
				env: process.env,
				windowsHide: true,
			});
			const onAbort = () => {
				child.kill();
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) onAbort();
			child.on("error", () => resolve(null));
			child.on("close", (code) => {
				signal?.removeEventListener("abort", onAbort);
				resolve(code);
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

export type DaemonAutoUpdateResult =
	| "disabled"
	| "no_update"
	| "unsupported"
	| "locked"
	| "installed"
	| "failed";

export async function daemonAutoUpdateOnce(
	opts: {
		currentVersion?: string;
		ownership?: GlobalInstallOwnership | null;
		installRunner?: InstallRunner;
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
	const channel = updateChannelForVersion(current);
	const latest = await latestFromCacheOrRegistry(channel);
	if (!latest || !isNewer(latest, current)) return "no_update";

	const ownership = opts.ownership === undefined ? detectGlobalInstall() : opts.ownership;
	if (!ownership) {
		log.warn("daemon.auto_update_unsupported", { current, latest, channel });
		return "unsupported";
	}
	const { installer } = ownership;

	const release = acquireDaemonUpdateLock();
	if (!release) return "locked";
	try {
		log.info("daemon.auto_update_installing", { current, latest, channel, installer });
		const installAndValidate = async (): Promise<DaemonAutoUpdateResult> => {
			const status = await (opts.installRunner ?? runInstall)(
				installer,
				installArgs(installer, latest),
				opts.signal,
			);
			if (status !== 0) {
				log.warn("daemon.auto_update_failed", { current, latest, channel, installer, status });
				return "failed";
			}
			const installedVersion = (opts.versionReader ?? readExecutableVersion)(ownership.executable);
			if (installedVersion !== latest) {
				log.warn("daemon.auto_update_validation_failed", {
					current,
					latest,
					channel,
					installer,
					installed_version: installedVersion,
				});
				return "failed";
			}
			writeLastVersion(current);
			log.info("daemon.auto_update_installed", { from: current, to: latest, channel, installer });
			return "installed";
		};
		return opts.restartCoordination
			? await opts.restartCoordination.duringUpdateInstall(installAndValidate)
			: await installAndValidate();
	} finally {
		release();
	}
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
 *   2. If a newer release exists in the cache, install that exact version
 *      in the background so the next invocation gets it.
 *
 * Opt-out: `CLAWDI_NO_AUTO_UPDATE=1` env, `clawdi config set autoUpdate
 * false`, non-TTY (CI), or running via npx/bunx.
 */
export async function maybeAutoUpdate(runtime: AutoUpdateRuntime = {}): Promise<void> {
	if (detectRuntimeMode() === "hosted") return;
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
	const channel = updateChannelForVersion(current);

	if (process.env.CLAWDI_NO_AUTO_UPDATE) return;
	if (process.env.CLAWDI_NO_UPDATE_CHECK) return;
	if (!isHumanTerminal) return;
	if (isTransientInvocation()) return;

	// `clawdi config set autoUpdate false` writes the literal string "false";
	// fall back to a boolean compare for direct mutators of config.json.
	const stored = getStoredConfig() as { autoUpdate?: unknown };
	if (stored.autoUpdate === false || stored.autoUpdate === "false") return;

	const cached = readCache(channel);
	const now = Date.now();
	let latest: string | null = cached?.latest ?? null;

	if (!cached) {
		// First run on this machine — no cache to fall back on. Block briefly
		// for a registry lookup (3 s timeout); without this the first
		// auto-update opportunity is silently dropped, costing the user one
		// stale invocation before the system kicks in.
		latest = await fetchLatest(3000, channel);
		if (latest) writeCache(latest, channel);
	} else if (now - new Date(cached.checkedAt).getTime() > CACHE_TTL_MS) {
		// Have stale data — use it now, refresh in the background for the
		// next invocation. Keeps the hot path snappy after the first run.
		fetchLatest(3000, channel)
			.then((l) => {
				if (l) writeCache(l, channel);
			})
			.catch(() => {});
	}

	if (!latest) return;
	if (!isNewer(latest, current)) return;

	const ownership = detectAutoUpdateOwnership(runtime);
	if (!ownership) return;
	const { installer } = ownership;
	const args = installArgs(installer, latest);

	// Redirect installer output to a logfile so silent failures (network
	// flake, perms error, npm 4xx) leave a trail. `stdio: "ignore"` would
	// throw the diagnosis away. Append (`"a"`) instead of truncate (`"w"`)
	// so two concurrent CLI invocations spawning their own installs (which
	// is rare but legal — the lock is gone on purpose) don't clobber each
	// other's logs.
	const logPath = join(getClawdiDir(), "auto-update.log");
	let logFd: number;
	try {
		mkdirSync(getClawdiDir(), { recursive: true });
		logFd = openSync(logPath, "a");
	} catch {
		// Fall back to ignore — best-effort. The install can still succeed.
		logFd = -1;
	}

	console.log(chalk.gray(`Updating clawdi v${current} → v${latest} in background…`));
	try {
		const spawner = runtime.spawnBackgroundInstall ?? spawnBackgroundInstall;
		spawner(installer, args, { current, latest, logFd });
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

function spawnBackgroundInstall(
	installer: Installer,
	args: string[],
	context: BackgroundInstallContext,
): void {
	const vector = installerCommandVector(installer, args);
	const child = spawn(vector.command, vector.args, {
		stdio: context.logFd >= 0 ? ["ignore", context.logFd, context.logFd] : "ignore",
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
