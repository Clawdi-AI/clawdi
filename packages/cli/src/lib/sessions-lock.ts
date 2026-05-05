import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
	const dir = getClawdiDir();
	// Daemon under env-only auth (CLAWDI_AUTH_TOKEN, no prior
	// `clawdi auth login`) on a fresh HOME — typical hosted /
	// container path — may not have `~/.clawdi/` yet. Without this
	// mkdir the first successful upload's lock write throws ENOENT,
	// the queue records the already-uploaded item as failed, and
	// it gets retried (or eventually evicted). 0o700 to match the
	// auth.json mode used elsewhere in this dir.
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const path = join(dir, LOCK_FILE);
	// Sort keys for deterministic output — keeps `git diff` readable when
	// the file is committed (some users do this for VCS-backed clawdi
	// state) and stabilizes any future test snapshots.
	const sortedSessions: Record<string, { hash: string }> = {};
	for (const key of Object.keys(lock.sessions).sort()) {
		const entry = lock.sessions[key];
		if (entry) sortedSessions[key] = entry;
	}
	const sorted: SessionsLock = { version: lock.version, sessions: sortedSessions };
	// Atomic write: temp file + rename. `--all` mode runs N daemons
	// (one per agent) on the same machine, all sharing this single
	// lock file. Without atomic rename the read-modify-write would
	// truncate-and-overwrite, allowing two daemons writing within
	// the same OS-scheduled tick to lose each other's keys (or
	// produce a half-written file the next reader rejects). The
	// rename is atomic on POSIX so the worst case is "one daemon's
	// hash didn't land, next push catches it" — never corruption.
	const tmp = `${path}.tmp.${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify(sorted, null, 2)}\n`, { mode: 0o600 });
	renameSync(tmp, path);
	// Re-apply mode in case a previous holder left it loose. The
	// mode option only fires at create time.
	try {
		chmodSync(path, 0o600);
	} catch {
		/* best effort */
	}
}

function emptyLock(): SessionsLock {
	return { version: CURRENT_VERSION, sessions: {} };
}
