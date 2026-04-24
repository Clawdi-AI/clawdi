import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { getClawdiDir } from "../lib/config";
import { getCliVersion } from "../lib/version";

const REGISTRY_URL = "https://registry.npmjs.org/@clawdi/cli";
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

function isNewer(latest: string, current: string): boolean {
	const parse = (v: string) => v.split(".").map((n) => Number.parseInt(n, 10) || 0);
	const [la = 0, lb = 0, lc = 0] = parse(latest);
	const [ca = 0, cb = 0, cc = 0] = parse(current);
	if (la !== ca) return la > ca;
	if (lb !== cb) return lb > cb;
	return lc > cc;
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
				chalk.white("npm i -g @clawdi/cli"),
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
					`  (v${cached.latest} available — run \`clawdi update\` or \`npm i -g @clawdi/cli\`)`,
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
