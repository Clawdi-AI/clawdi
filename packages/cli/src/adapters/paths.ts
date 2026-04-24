import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Directory names to skip when scanning for skills. Applied by every adapter's
 * `collectSkills()`. Lives here (not in registry.ts) to avoid a cycle, since
 * registry.ts already imports every adapter.
 */
export const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "__pycache__"]);

// All getters compute lazily. Module-level constants would freeze the path at
// import time and ignore env changes (and break per-test HOME overrides).
// We read `$HOME` directly because os.homedir() is cached by the runtime.

function home(): string {
	return process.env.HOME || homedir();
}

/** Claude Code: honors `$CLAUDE_CONFIG_DIR`; fallback `~/.claude`. */
export function getClaudeHome(): string {
	return process.env.CLAUDE_CONFIG_DIR?.trim() || join(home(), ".claude");
}

/** Codex: honors `$CODEX_HOME`; fallback `~/.codex`. */
export function getCodexHome(): string {
	return process.env.CODEX_HOME?.trim() || join(home(), ".codex");
}

/** Hermes: honors `$HERMES_HOME`; fallback `~/.hermes`. */
export function getHermesHome(): string {
	return process.env.HERMES_HOME?.trim() || join(home(), ".hermes");
}

/**
 * OpenClaw: honors `$OPENCLAW_STATE_DIR`, else probes `.openclaw` → `.clawdbot` → `.moltbot`
 * (same multi-name fallback vercel/skills uses in `getOpenClawGlobalSkillsDir`).
 */
export function getOpenClawHome(): string {
	const override = process.env.OPENCLAW_STATE_DIR?.trim();
	if (override) return override;
	const h = home();
	for (const name of [".openclaw", ".clawdbot", ".moltbot"]) {
		const dir = join(h, name);
		if (existsSync(dir)) return dir;
	}
	return join(h, ".openclaw");
}

/**
 * XDG config home. Used for locating OTHER agents (Amp, Goose, OpenCode)
 * whose own config follows XDG on Linux. NOT used for clawdi's own state
 * — clawdi stays in `~/.clawdi/`.
 */
export function getXdgConfigHome(): string {
	return process.env.XDG_CONFIG_HOME?.trim() || join(home(), ".config");
}

// Future adapters will pick a home function here — examples below, no
// implementation wired up yet:
//
//   - Amp:          join(getXdgConfigHome(), "amp")
//   - Goose:        join(getXdgConfigHome(), "goose")
//   - OpenCode:     join(getXdgConfigHome(), "opencode")
//   - Antigravity:  join(home(), ".gemini", "antigravity")
//   - Gemini CLI:   join(home(), ".gemini")
//   - Cursor:       join(home(), ".cursor")
//   - Continue:     join(home(), ".continue")
//   - Augment:      join(home(), ".augment")
//   - Cline:        join(home(), ".cline")
