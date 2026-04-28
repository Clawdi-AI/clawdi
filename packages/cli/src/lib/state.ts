import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { getClawdiDir } from "./config";

/**
 * Per-module activity tracked in `~/.clawdi/state.json`.
 *
 * `lastActivityAt` is informational — surfaced by `clawdi status` so users
 * know when a module last did anything. The session sync's content-hash
 * cache lives separately in `~/.clawdi/sessions-lock.json`; see
 * `lib/sessions-lock.ts`.
 */
export interface ModuleState {
	[module: string]: {
		lastActivityAt?: string;
	};
}

const STATE_FILE = "state.json";

/**
 * Read `~/.clawdi/state.json` — per-module last-activity timestamps.
 * Tolerates a corrupt file by warning and resetting to {}; the next push/pull
 * rewrites it cleanly.
 */
export function readModuleState(): ModuleState {
	const path = join(getClawdiDir(), STATE_FILE);
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		console.log(chalk.yellow(`⚠ ~/.clawdi/${STATE_FILE} is corrupted; resetting.`));
		return {};
	}
}

export function writeModuleState(state: ModuleState) {
	const path = join(getClawdiDir(), STATE_FILE);
	writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}
