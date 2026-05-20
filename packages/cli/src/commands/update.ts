import { spawn, spawnSync } from "node:child_process";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { getClawdiDir, getStoredConfig } from "../lib/config";
import { getCliVersion } from "../lib/version";
import { listInstalledAgents, readHealth } from "../serve/installer";
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
type Installer = "bun" | "npm";

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
	detectInstaller?: () => Installer | null;
	spawnBackgroundInstall?: (
		installer: Installer,
		args: string[],
		context: BackgroundInstallContext,
	) => void;
};

function cachePath(): string {
	return join(getClawdiDir(), "update.json");
}

function readCache(): UpdateCache | null {
	try {
		const p = cachePath();
		if (!existsSync(p)) return null;
		return JSON.parse(readFileSync(p, "utf-8")) as UpdateCache;
	} catch {
		return null;
	}
}

function writeCache(latest: string): void {
	try {
		writeFileSync(
			cachePath(),
			`${JSON.stringify({ checkedAt: new Date().toISOString(), latest }, null, 2)}\n`,
			{ mode: 0o600 },
		);
	} catch {
		// best-effort; ignore
	}
}

async function fetchLatest(timeoutMs = 3000): Promise<string | null> {
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		const res = await fetch(REGISTRY_URL, { signal: controller.signal });
		clearTimeout(timer);
		if (!res.ok) return null;
		const data = (await res.json()) as { "dist-tags"?: { latest?: string } };
		return data["dist-tags"]?.latest ?? null;
	} catch {
		return null;
	}
}

// Parse an npm version string ("1.2.3" or "1.2.3-beta.4") into comparable
// parts. The numeric triple dominates; the pre-release suffix is a tiebreaker
// where a stable version beats any `-pre`-tagged build at the same triple
// (npm semver: `1.2.3 > 1.2.3-beta.4`).
function parseVersion(v: string): { triple: [number, number, number]; pre: string | null } {
	const [core, pre] = v.split("-", 2);
	const [a = 0, b = 0, c = 0] = (core ?? "").split(".").map((n) => Number.parseInt(n, 10) || 0);
	return { triple: [a, b, c], pre: pre ?? null };
}

function isNewer(latest: string, current: string): boolean {
	const L = parseVersion(latest);
	const C = parseVersion(current);
	for (let i = 0; i < 3; i++) {
		if (L.triple[i] !== C.triple[i]) return L.triple[i] > C.triple[i];
	}
	// Same numeric triple: stable (no pre) > pre-release; otherwise string cmp.
	if (L.pre === C.pre) return false;
	if (L.pre === null) return true;
	if (C.pre === null) return false;
	return L.pre > C.pre;
}

/**
 * Manual `clawdi update` — forces a registry fetch and, if a newer version
 * exists, installs it inline (foreground, blocking, with the installer's
 * own progress output). Pass `--check` to keep the old "diagnose only"
 * behavior. JSON / non-TTY runs always stay diagnose-only because piping
 * into a script and silently mutating the global install would surprise.
 */
export async function update(opts: { json?: boolean; check?: boolean } = {}) {
	const current = getCliVersion();
	const latest = await fetchLatest();

	if (latest) writeCache(latest);

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
		console.log();
		console.log(
			chalk.cyan(`A newer version is available. Install with:`) +
				"\n  " +
				chalk.white("npm i -g clawdi"),
		);
		return;
	}

	const installer = detectInstaller();
	if (!installer) {
		console.log();
		console.log(
			chalk.yellow("Neither bun nor npm is on PATH; install manually:") +
				"\n  " +
				chalk.white("npm i -g clawdi"),
		);
		return;
	}

	const args = installer === "bun" ? ["add", "-g", "clawdi@latest"] : ["i", "-g", "clawdi@latest"];
	console.log();
	console.log(chalk.cyan(`Installing v${latest} via ${installer}…`));
	const result = spawnSync(installer, args, { stdio: "inherit" });
	if (result.status !== 0) {
		console.log();
		console.log(
			chalk.red(`Install failed (${installer} exited ${result.status}). Try manually:`) +
				"\n  " +
				chalk.white("npm i -g clawdi"),
		);
		process.exitCode = result.status ?? 1;
		return;
	}
	// Update last-version so the post-install run prints "Updated to v…".
	try {
		writeFileSync(lastVersionPath(), current, { mode: 0o644 });
	} catch {
		// best-effort
	}
	console.log();
	console.log(chalk.green(`✓ clawdi v${latest} installed.`));
}

const LAST_VERSION_FILE = "last-version";

function lastVersionPath(): string {
	return join(getClawdiDir(), LAST_VERSION_FILE);
}

function detectInstaller(): Installer | null {
	for (const name of ["bun", "npm"] as const) {
		try {
			const r = spawnSync(name, ["--version"], { stdio: "ignore" });
			if (r.status === 0) return name;
		} catch {
			// fall through
		}
	}
	return null;
}

function detectAutoUpdateInstaller(runtime: AutoUpdateRuntime): Installer | null {
	return runtime.detectInstaller?.() ?? detectInstaller();
}

function installArgs(installer: Installer): string[] {
	return installer === "bun" ? ["add", "-g", "clawdi@latest"] : ["i", "-g", "clawdi@latest"];
}

// `npx clawdi …` and `bunx clawdi …` install the package into a per-call
// temp dir. Running `npm i -g clawdi` from that temp invocation would put a
// global binary on the user's PATH that they didn't ask for. Detect those
// paths and skip auto-update — the next npx call will fetch latest anyway.
//
// Normalise backslashes first so Windows `C:\Users\…\_npx\…` matches the
// same regex; otherwise the guard quietly fails open and a Windows npx
// invocation tries to globally install itself. The patterns are anchored
// to a leading slash to avoid false positives on legit paths that happen
// to contain `npx` somewhere.
function isTransientInvocation(): boolean {
	const argv1 = (process.argv[1] ?? "").replace(/\\/g, "/");
	return /\/_npx\/|\/\.bunx-|\/bun\/install\/cache\//.test(argv1);
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

function outdatedDaemonAgents(current: string): string[] {
	try {
		return listInstalledAgents().filter((agent) => {
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

async function latestFromCacheOrRegistry(): Promise<string | null> {
	const cached = readCache();
	const now = Date.now();
	if (cached && now - new Date(cached.checkedAt).getTime() <= CACHE_TTL_MS) {
		return cached.latest;
	}
	const latest = await fetchLatest();
	if (latest) {
		writeCache(latest);
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
			const child = spawn(installer, args, {
				stdio: logFd >= 0 ? ["ignore", logFd, logFd] : "ignore",
				env: process.env,
			});
			const onAbort = () => {
				child.kill();
			};
			signal?.addEventListener("abort", onAbort, { once: true });
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
	| "no_installer"
	| "locked"
	| "installed"
	| "failed";

export async function daemonAutoUpdateOnce(
	opts: {
		currentVersion?: string;
		installer?: Installer | null;
		installRunner?: InstallRunner;
		signal?: AbortSignal;
	} = {},
): Promise<DaemonAutoUpdateResult> {
	if (autoUpdateDisabled()) return "disabled";
	if (opts.signal?.aborted) return "disabled";

	const current = opts.currentVersion ?? getCliVersion();
	const latest = await latestFromCacheOrRegistry();
	if (!latest || !isNewer(latest, current)) return "no_update";

	const installer = opts.installer === undefined ? detectInstaller() : opts.installer;
	if (!installer) {
		log.warn("daemon.auto_update_no_installer", { current, latest });
		return "no_installer";
	}

	const release = acquireDaemonUpdateLock();
	if (!release) return "locked";
	try {
		log.info("daemon.auto_update_installing", { current, latest, installer });
		const status = await (opts.installRunner ?? runInstall)(
			installer,
			installArgs(installer),
			opts.signal,
		);
		if (status !== 0) {
			log.warn("daemon.auto_update_failed", { current, latest, installer, status });
			return "failed";
		}
		try {
			writeFileSync(lastVersionPath(), current, { mode: 0o644 });
		} catch {
			// best-effort; the installed binary still wins.
		}
		log.info("daemon.auto_update_installed", { from: current, to: latest, installer });
		return "installed";
	} finally {
		release();
	}
}

export function startDaemonAutoUpdate(opts: {
	abort: AbortController;
	intervalMs?: number;
	initialDelayMs?: number;
}): boolean {
	if (autoUpdateDisabled()) return false;
	const intervalMs = opts.intervalMs ?? DAEMON_UPDATE_INTERVAL_MS;
	const initialDelayMs =
		opts.initialDelayMs ?? Math.min(5 * 60_000, intervalMs) + Math.floor(Math.random() * 60_000);

	void (async () => {
		await sleep(initialDelayMs, opts.abort.signal);
		while (!opts.abort.signal.aborted) {
			const result = await daemonAutoUpdateOnce({ signal: opts.abort.signal });
			if (result === "installed") {
				opts.abort.abort();
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
 *   2. If a newer release exists in the cache, kick off a detached
 *      `npm/bun add -g clawdi@latest` so the next invocation gets it.
 *
 * Opt-out: `CLAWDI_NO_AUTO_UPDATE=1` env, `clawdi config set autoUpdate
 * false`, non-TTY (CI), or running via npx/bunx.
 */
export async function maybeAutoUpdate(runtime: AutoUpdateRuntime = {}): Promise<void> {
	if (
		isLongLivedDaemonInvocation() ||
		isAutoUpdateControlInvocation() ||
		isInformationalInvocation()
	) {
		return;
	}

	const current = getCliVersion();
	const isHumanTerminal = !!process.stdout.isTTY;

	// Notify on the FIRST run after a successful background install — the
	// new binary's `getCliVersion()` no longer matches what we wrote last
	// time. After-the-fact is the only honest signal we have, since the
	// detached spawn can't write a marker that the parent reliably sees.
	//
	// Keep this notice out of piped / scripted output. `clawdi --version`,
	// `--json` commands, and shell completions need stdout to stay machine-
	// parseable even on the first run after an update.
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
					console.log(
						chalk.gray(
							`  Restart ${outdatedDaemons.length === 1 ? "the daemon" : "daemons"} to pick it up: clawdi daemon restart --all`,
						),
					);
				}
			}
		}
		writeFileSync(lastFile, current, { mode: 0o644 });
	} catch {
		// best-effort
	}

	if (process.env.CLAWDI_NO_AUTO_UPDATE) return;
	if (process.env.CLAWDI_NO_UPDATE_CHECK) return;
	if (!isHumanTerminal) return;
	if (isTransientInvocation()) return;

	// `clawdi config set autoUpdate false` writes the literal string "false";
	// fall back to a boolean compare for direct mutators of config.json.
	const stored = getStoredConfig() as { autoUpdate?: unknown };
	if (stored.autoUpdate === false || stored.autoUpdate === "false") return;

	const cached = readCache();
	const now = Date.now();
	let latest: string | null = cached?.latest ?? null;

	if (!cached) {
		// First run on this machine — no cache to fall back on. Block briefly
		// for a registry lookup (3 s timeout); without this the first
		// auto-update opportunity is silently dropped, costing the user one
		// stale invocation before the system kicks in.
		latest = await fetchLatest();
		if (latest) writeCache(latest);
	} else if (now - new Date(cached.checkedAt).getTime() > CACHE_TTL_MS) {
		// Have stale data — use it now, refresh in the background for the
		// next invocation. Keeps the hot path snappy after the first run.
		fetchLatest()
			.then((l) => {
				if (l) writeCache(l);
			})
			.catch(() => {});
	}

	if (!latest) return;
	if (!isNewer(latest, current)) return;

	const installer = detectAutoUpdateInstaller(runtime);
	if (!installer) return;

	// No single-flight lock. Two concurrent CLIs both spawning `npm i -g
	// clawdi@latest` would serialize on npm's own per-package install lock —
	// at worst one waits, both end up at the same target version. The
	// previous mkdir-based lock added stale-recovery complexity for a
	// non-correctness gain (saving one redundant spawn + a duplicate
	// "Updating…" line); not worth it.
	//
	// `clawdi@latest` (not the pinned cache version) keeps installs
	// idempotent — a newer release landing between cache write and now is
	// picked up automatically, and `last-version` on next invocation
	// detects the change.
	const args = installArgs(installer);

	// Redirect installer output to a logfile so silent failures (network
	// flake, perms error, npm 4xx) leave a trail. `stdio: "ignore"` would
	// throw the diagnosis away. Append (`"a"`) instead of truncate (`"w"`)
	// so two concurrent CLI invocations spawning their own installs (which
	// is rare but legal — the lock is gone on purpose) don't clobber each
	// other's logs.
	const logPath = join(getClawdiDir(), "auto-update.log");
	let logFd: number;
	try {
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
	const child = spawn(installer, args, {
		stdio: context.logFd >= 0 ? ["ignore", context.logFd, context.logFd] : "ignore",
		detached: true,
		// Pass env explicitly so a future change to spawn defaults can't
		// strip NPM_CONFIG_PREFIX / BUN_INSTALL and silently install into
		// the wrong global location.
		env: process.env,
	});
	child.on("error", () => {
		// Installer missing / crashed — silent skip; the user still sees
		// `auto-update.log` if they care, and the next invocation retries.
	});
	child.unref();
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
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
