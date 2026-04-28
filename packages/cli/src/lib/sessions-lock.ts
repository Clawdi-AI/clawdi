import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import type { AgentType } from "../adapters/registry";
import { getClawdiDir } from "./config";

/**
 * Per-session content-hash cache used by `clawdi push` to decide which
 * sessions are already in sync with the cloud. Modeled after the Vercel
 * skills CLI's `skills-lock.json` (`/Users/paco/workspace/skills/src/local-lock.ts`)
 * — single JSON file, flat key/value, version-stamped for forward compat.
 *
 * Authoritative state is the cloud. This file is purely an optimization;
 * deleting it just forces the next push to re-confirm every session
 * against the server, which is safe (server is source of truth on
 * what's already stored).
 */
export interface SessionsLock {
	version: 1;
	// Key is `cacheKey(agentType, localSessionId)`. Flat namespace so a
	// single-session change yields a one-line JSON diff. Value is the
	// content hash that was last successfully synced with the server.
	sessions: Record<string, { hash: string }>;
}

const LOCK_FILE = "sessions-lock.json";
const CURRENT_VERSION = 1;

/**
 * Composite key combining agent type and local session id. Local session
 * ids alone are NOT globally unique across agents (Claude Code's UUID
 * scheme can collide with Codex's), so we namespace by agent type.
 */
export function cacheKey(agentType: AgentType, localSessionId: string): string {
	return `${agentType}:${localSessionId}`;
}

/**
 * Read `~/.clawdi/sessions-lock.json`. Returns an empty cache when the
 * file is missing, corrupt, or written by a future version. The next
 * push will re-warm the cache from server hash diffs — no harm done.
 */
export function readSessionsLock(): SessionsLock {
	const path = join(getClawdiDir(), LOCK_FILE);
	if (!existsSync(path)) return emptyLock();
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as SessionsLock;
		if (parsed.version !== CURRENT_VERSION || !parsed.sessions) return emptyLock();
		return parsed;
	} catch {
		console.log(chalk.yellow(`⚠ ~/.clawdi/${LOCK_FILE} is corrupted; resetting.`));
		return emptyLock();
	}
}

export function writeSessionsLock(lock: SessionsLock): void {
	const path = join(getClawdiDir(), LOCK_FILE);
	// Sort keys for deterministic output — keeps `git diff` readable when
	// the file is committed (some users do this for VCS-backed clawdi
	// state) and stabilizes any future test snapshots.
	const sortedSessions: Record<string, { hash: string }> = {};
	for (const key of Object.keys(lock.sessions).sort()) {
		const entry = lock.sessions[key];
		if (entry) sortedSessions[key] = entry;
	}
	const sorted: SessionsLock = { version: lock.version, sessions: sortedSessions };
	writeFileSync(path, `${JSON.stringify(sorted, null, 2)}\n`, { mode: 0o600 });
}

function emptyLock(): SessionsLock {
	return { version: CURRENT_VERSION, sessions: {} };
}
