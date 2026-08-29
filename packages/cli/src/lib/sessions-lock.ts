import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import type { AgentType } from "../adapters/registry";
import { getClawdiDir } from "./config";

export interface SessionFence {
	apiOrigin: string;
	environmentId: string;
	adapter: AgentType;
	sourceSessionKey: string;
}

export interface PendingEventUpload {
	kind: "append" | "rewrite";
	append_id: string;
	generation: string;
	base_generation: string | null;
	base_revision: number;
	base_count: number;
	base_head_hash: string;
	final_count: number;
	final_head_hash: string;
}

export interface SessionUploadBlock {
	code: "legacy_session_too_large" | "event_too_large";
	content_hash: string;
	size_bytes: number;
	message: string;
	blocked_at: string;
}

export interface FencedSessionLockEntry {
	api_origin: string;
	environment_id: string;
	adapter: AgentType;
	source_session_key: string;
	protocol: "snapshot-v1" | "events-v1";
	local_hash: string;
	source_revision?: string;
	snapshot_hash?: string;
	event_generation?: string;
	event_revision?: number;
	event_count?: number;
	event_head_hash?: string;
	pending?: PendingEventUpload;
	blocked?: SessionUploadBlock;
}

export interface FencedSessionSourceRevisionUpdate {
	fence: SessionFence;
	protocol: FencedSessionLockEntry["protocol"];
	localHash: string;
	sourceRevision: string;
}

export interface LegacySessionLockEntry {
	hash: string;
}

export type SessionLockEntry = FencedSessionLockEntry | LegacySessionLockEntry;

export type SessionsLock =
	| { version: 1; sessions: Record<string, LegacySessionLockEntry> }
	| { version: 2; sessions: Record<string, SessionLockEntry> };

const LOCK_FILE = "sessions-lock.json";
const CURRENT_VERSION = 2;

/** Legacy v1 cache key retained only so deployed lock files remain readable. */
export function cacheKey(agentType: AgentType, localSessionId: string): string {
	return `${agentType}:${localSessionId}`;
}

export function sessionFenceKey(fence: SessionFence): string {
	const identity = JSON.stringify([
		fence.apiOrigin,
		fence.environmentId,
		fence.adapter,
		fence.sourceSessionKey,
	]);
	return `v2:${createHash("sha256").update(identity).digest("hex")}`;
}

export function readFencedSessionEntry(
	lock: SessionsLock,
	fence: SessionFence,
): FencedSessionLockEntry | undefined {
	if (lock.version !== 2) return undefined;
	const entry = lock.sessions[sessionFenceKey(fence)];
	if (!isFencedSessionLockEntry(entry)) return undefined;
	return entry.api_origin === fence.apiOrigin &&
		entry.environment_id === fence.environmentId &&
		entry.adapter === fence.adapter &&
		entry.source_session_key === fence.sourceSessionKey
		? entry
		: undefined;
}

export function writeFencedSessionEntry(
	lock: SessionsLock,
	fence: SessionFence,
	entry: Omit<
		FencedSessionLockEntry,
		"api_origin" | "environment_id" | "adapter" | "source_session_key"
	>,
): SessionsLock {
	const current = toCurrentLock(lock);
	current.sessions[sessionFenceKey(fence)] = {
		api_origin: fence.apiOrigin,
		environment_id: fence.environmentId,
		adapter: fence.adapter,
		source_session_key: fence.sourceSessionKey,
		...entry,
	};
	return current;
}

export function removeFencedSessionEntry(lock: SessionsLock, fence: SessionFence): SessionsLock {
	const current = toCurrentLock(lock);
	delete current.sessions[sessionFenceKey(fence)];
	return current;
}

export function persistFencedSessionEntry(
	fence: SessionFence,
	entry: Omit<
		FencedSessionLockEntry,
		"api_origin" | "environment_id" | "adapter" | "source_session_key"
	>,
): void {
	writeSessionsLock(writeFencedSessionEntry(readSessionsLock(), fence, entry));
}

export function clearFencedSessionEntry(fence: SessionFence): void {
	writeSessionsLock(removeFencedSessionEntry(readSessionsLock(), fence));
}

export function persistFencedSessionSourceRevisions(
	updates: readonly FencedSessionSourceRevisionUpdate[],
): void {
	if (updates.length === 0) return;
	const lock = readSessionsLock();
	let changed = false;
	for (const update of updates) {
		const entry = readFencedSessionEntry(lock, update.fence);
		if (
			!entry ||
			entry.pending !== undefined ||
			entry.protocol !== update.protocol ||
			entry.local_hash !== update.localHash ||
			entry.source_revision === update.sourceRevision
		) {
			continue;
		}
		entry.source_revision = update.sourceRevision;
		changed = true;
	}
	if (changed) writeSessionsLock(lock);
}

/** Read the current lock while accepting v1 without trusting its unfenced hash. */
export function readSessionsLock(): SessionsLock {
	const path = join(getClawdiDir(), LOCK_FILE);
	if (!existsSync(path)) return emptyLock();
	try {
		const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (!isObject(raw) || !isObject(raw.sessions)) return emptyLock();
		if (raw.version === 1) {
			const sessions: Record<string, LegacySessionLockEntry> = {};
			for (const [key, value] of Object.entries(raw.sessions)) {
				if (isLegacyEntry(value)) sessions[key] = value;
			}
			return { version: 1, sessions };
		}
		if (raw.version === CURRENT_VERSION) {
			const sessions: Record<string, SessionLockEntry> = {};
			for (const [key, value] of Object.entries(raw.sessions)) {
				if (isLegacyEntry(value) || isFencedSessionLockEntry(value)) sessions[key] = value;
			}
			return { version: CURRENT_VERSION, sessions };
		}
		return emptyLock();
	} catch {
		console.log(chalk.yellow(`⚠ ~/.clawdi/${LOCK_FILE} is corrupted; resetting.`));
		return emptyLock();
	}
}

export function writeSessionsLock(lock: SessionsLock): void {
	const dir = getClawdiDir();
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const path = join(dir, LOCK_FILE);
	const current = toCurrentLock(lock);
	const sortedSessions: Record<string, SessionLockEntry> = {};
	for (const key of Object.keys(current.sessions).sort()) {
		const entry = current.sessions[key];
		if (entry) sortedSessions[key] = entry;
	}
	const sorted: SessionsLock = { version: CURRENT_VERSION, sessions: sortedSessions };
	const tmp = `${path}.tmp.${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify(sorted, null, 2)}\n`, { mode: 0o600 });
	renameSync(tmp, path);
	try {
		chmodSync(path, 0o600);
	} catch {
		/* best effort */
	}
}

function toCurrentLock(lock: SessionsLock): Extract<SessionsLock, { version: 2 }> {
	return lock.version === 2 ? lock : { version: CURRENT_VERSION, sessions: { ...lock.sessions } };
}

function emptyLock(): Extract<SessionsLock, { version: 2 }> {
	return { version: CURRENT_VERSION, sessions: {} };
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLegacyEntry(value: unknown): value is LegacySessionLockEntry {
	return isObject(value) && typeof value.hash === "string";
}

export function isFencedSessionLockEntry(value: unknown): value is FencedSessionLockEntry {
	if (!isObject(value)) return false;
	return (
		typeof value.api_origin === "string" &&
		typeof value.environment_id === "string" &&
		typeof value.adapter === "string" &&
		typeof value.source_session_key === "string" &&
		(value.protocol === "snapshot-v1" || value.protocol === "events-v1") &&
		(value.source_revision === undefined || typeof value.source_revision === "string")
	);
}
