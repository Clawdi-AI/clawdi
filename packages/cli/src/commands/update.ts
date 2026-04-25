import { spawn, spawnSync } from "node:child_process";
import { existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { getClawdiDir, getStoredConfig } from "../lib/config";
import { getCliVersion } from "../lib/version";

const REGISTRY_URL = "https://registry.npmjs.org/clawdi";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 h

interface UpdateCache {
	checkedAt: string;
	latest: string;
}

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
 * Manual `clawdi update` command — forces a registry fetch and prints result.
 */
export async function update(opts: { json?: boolean } = {}) {
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
	if (isNewer(latest, current)) {
		console.log();
		console.log(
			chalk.cyan(`A newer version is available. Install with:`) +
				"\n  " +
				chalk.white("npm i -g clawdi"),
		);
	} else {
		console.log(chalk.green("\n✓ You're up to date."));
	}
}

/**
 * Non-blocking background check used at the end of commands.
 * Returns quickly on cache hit, fires a background fetch otherwise.
 */
export async function maybeNotifyOutdated(): Promise<void> {
	if (process.env.CLAWDI_NO_UPDATE_CHECK) return;
	if (!process.stdout.isTTY) return;

	const current = getCliVersion();
	const cached = readCache();
	const now = Date.now();

	if (cached?.latest && now - new Date(cached.checkedAt).getTime() < CACHE_TTL_MS) {
		if (isNewer(cached.latest, current)) {
			console.log();
			console.log(
				chalk.gray(
					`  (v${cached.latest} available — run \`clawdi update\` or \`npm i -g clawdi\`)`,
				),
			);
		}
		return;
	}

	// Cache stale — refresh in the background; don't block caller.
	fetchLatest()
		.then((latest) => {
			if (latest) writeCache(latest);
		})
		.catch(() => {
			// best-effort
		});
}

const LAST_VERSION_FILE = "last-version";

function lastVersionPath(): string {
	return join(getClawdiDir(), LAST_VERSION_FILE);
}

function isMajorBump(current: string, latest: string): boolean {
	return parseVersion(latest).triple[0] > parseVersion(current).triple[0];
}

function detectInstaller(): "bun" | "npm" | null {
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

/**
 * Default-on auto-updater. On startup:
 *   1. If the binary version differs from `last-version` on disk, print a
 *      one-line "updated to v…" notice (the previous run's spawn finished).
 *   2. If a newer release exists in the cache, kick off a detached
 *      `npm/bun add -g clawdi@latest` so the next invocation gets it. Only
 *      patch + minor — major bumps print a hint and require explicit opt-in.
 *
 * Opt-out: `CLAWDI_NO_AUTO_UPDATE=1` env, `clawdi config set autoUpdate
 * false`, non-TTY (CI), or running via npx/bunx.
 */
export async function maybeAutoUpdate(): Promise<void> {
	const current = getCliVersion();

	// Notify on the FIRST run after a successful background install — the
	// new binary's `getCliVersion()` no longer matches what we wrote last
	// time. After-the-fact is the only honest signal we have, since the
	// detached spawn can't write a marker that the parent reliably sees.
	const lastFile = lastVersionPath();
	try {
		if (existsSync(lastFile)) {
			const last = readFileSync(lastFile, "utf-8").trim();
			if (last && last !== current && isNewer(current, last)) {
				console.log(
					`${chalk.green("✓")} ${chalk.gray(`Updated clawdi to v${current} (was v${last})`)}`,
				);
			}
		}
		writeFileSync(lastFile, current, { mode: 0o644 });
	} catch {
		// best-effort
	}

	if (process.env.CLAWDI_NO_AUTO_UPDATE) return;
	if (process.env.CLAWDI_NO_UPDATE_CHECK) return;
	if (!process.stdout.isTTY) return;
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

	if (isMajorBump(current, latest)) {
		console.log();
		console.log(
			chalk.cyan(`Major release v${latest} available — run \`clawdi update\` to install.`),
		);
		return;
	}

	const installer = detectInstaller();
	if (!installer) return;

	// No single-flight lock. Two concurrent CLIs both spawning `npm i -g
	// clawdi@latest` would serialize on npm's own per-package install lock —
	// at worst one waits, both end up at the same target version. The
	// previous mkdir-based lock added stale-recovery complexity for a
	// non-correctness gain (saving one redundant spawn + a duplicate
	// "Updating…" line); not worth it.
	//
	// `clawdi@latest` (not the pinned cache version) keeps installs
	// idempotent — a newer patch landing between cache write and now is
	// picked up automatically, and `last-version` on next invocation
	// detects the change.
	const args = installer === "bun" ? ["add", "-g", "clawdi@latest"] : ["i", "-g", "clawdi@latest"];

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
	const child = spawn(installer, args, {
		stdio: logFd >= 0 ? ["ignore", logFd, logFd] : "ignore",
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
