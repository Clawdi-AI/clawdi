/**
 * Resolves on-disk locations for `clawdi serve`.
 *
 * Two override knobs, in precedence order:
 *
 *   1. `CLAWDI_STATE_DIR` — explicit serve-state-only redirect.
 *      Pods that mount a writable scratch volume into a non-home
 *      path use this to keep queue.jsonl / health out of the
 *      read-only image filesystem, while keeping auth/config at
 *      `~/.clawdi/`.
 *
 *   2. `CLAWDI_HOME` — overrides the whole CLI state tree (set
 *      by the `clawdi-dev` wrapper, test harnesses, multi-tenant
 *      service accounts). Without this fallback, a `CLAWDI_HOME`-
 *      isolated install would still write daemon queue + health
 *      into the user's real `~/.clawdi/serve/`, defeating the
 *      isolation guarantee. Mirrors `getClawdiDir()` in
 *      `lib/config.ts`.
 *
 *   3. Default `$HOME/.clawdi/serve/<agent>/` so the queue file
 *      sits alongside auth.json. Per-agent suffix matters: a
 *      laptop running both Claude Code and Codex daemons can't
 *      share `queue.jsonl` — atomic-rename would race and one
 *      daemon's view of the queue would silently overwrite the
 *      other's.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export function getServeStateDir(agentType: string): string {
	const stateOverride = process.env.CLAWDI_STATE_DIR;
	if (stateOverride) return join(stateOverride, agentType);
	const homeOverride = process.env.CLAWDI_HOME;
	if (homeOverride) return join(homeOverride, "serve", agentType);
	const home = process.env.HOME || homedir();
	return join(home, ".clawdi", "serve", agentType);
}

/** Path to a daemon's stderr/stdout log file. The daemon writes
 * structured JSON-per-line to stderr; stdout stays empty (reserved
 * for future MCP-style framing). Both files are created by
 * launchd/systemd at unit-load time per the path baked into the
 * unit definition (see `installer.ts`). */
export function getServeLogPath(agentType: string, stream: "stderr" | "stdout"): string {
	const homeOverride = process.env.CLAWDI_HOME;
	const root = homeOverride ?? join(process.env.HOME || homedir(), ".clawdi");
	return join(root, "serve", "logs", `${agentType}.${stream}.log`);
}
