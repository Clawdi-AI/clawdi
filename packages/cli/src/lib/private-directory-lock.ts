import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE, writePrivateFileAtomic } from "./private-file";

export type PrivateDirectoryLockOptions = {
	timeoutMs?: number;
	staleMs?: number;
	retryMs?: number;
	now?: () => number;
	isProcessAlive?: (pid: number) => boolean;
	/** Deterministic race-test hook; production callers leave this unset. */
	beforeReclaimRename?: () => void;
};

export type PrivateDirectoryLockLease = {
	readonly token: string;
	assertOwned(): void;
};

type LockOwner = {
	schemaVersion: "clawdi.privateDirectoryLockOwner.v1";
	pid: number;
	acquiredAt: string;
	token: string;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_STALE_MS = 60_000;
const DEFAULT_RETRY_MS = 50;

export class PrivateDirectoryLockTimeoutError extends Error {
	readonly lockDir: string;

	constructor(lockDir: string) {
		super(`timed out waiting for private lock at ${lockDir}`);
		this.name = "PrivateDirectoryLockTimeoutError";
		this.lockDir = lockDir;
	}
}

function errno(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

function ownerPath(lockDir: string): string {
	return join(lockDir, "owner.json");
}

function readOwner(lockDir: string): LockOwner | null {
	try {
		const value: unknown = JSON.parse(readFileSync(ownerPath(lockDir), "utf8"));
		if (!value || typeof value !== "object" || Array.isArray(value)) return null;
		const record = value as Record<string, unknown>;
		if (
			record.schemaVersion !== "clawdi.privateDirectoryLockOwner.v1" ||
			typeof record.pid !== "number" ||
			!Number.isInteger(record.pid) ||
			record.pid <= 0 ||
			typeof record.acquiredAt !== "string" ||
			!Number.isFinite(Date.parse(record.acquiredAt)) ||
			typeof record.token !== "string" ||
			!record.token
		) {
			return null;
		}
		return record as LockOwner;
	} catch {
		return null;
	}
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return !errno(error, "ESRCH");
	}
}

type StaleObservation =
	| { kind: "owner"; owner: LockOwner }
	| { kind: "ownerless"; mtimeMs: number };

function staleObservation(
	lockDir: string,
	options: Required<Pick<PrivateDirectoryLockOptions, "staleMs" | "now">> & {
		isProcessAlive: (pid: number) => boolean;
		beforeReclaimRename?: () => void;
	},
): StaleObservation | null {
	const owner = readOwner(lockDir);
	if (owner) {
		// A live process is never reclaimed by age. The caller's bounded wait
		// times out instead, so a slow refresh cannot lose ownership mid-write.
		return options.isProcessAlive(owner.pid) ? null : { kind: "owner", owner };
	}
	try {
		const mtimeMs = statSync(lockDir).mtimeMs;
		return options.now() - mtimeMs > options.staleMs ? { kind: "ownerless", mtimeMs } : null;
	} catch (error) {
		if (errno(error, "ENOENT")) return { kind: "ownerless", mtimeMs: 0 };
		throw error;
	}
}

function observationMatches(lockDir: string, observed: StaleObservation): boolean {
	if (observed.kind === "owner") {
		const moved = readOwner(lockDir);
		return (
			moved?.token === observed.owner.token &&
			moved.pid === observed.owner.pid &&
			moved.acquiredAt === observed.owner.acquiredAt
		);
	}
	if (readOwner(lockDir) !== null) return false;
	try {
		return statSync(lockDir).mtimeMs === observed.mtimeMs;
	} catch {
		return false;
	}
}

function reclaimStaleLock(
	lockDir: string,
	options: Required<Pick<PrivateDirectoryLockOptions, "staleMs" | "now">> & {
		isProcessAlive: (pid: number) => boolean;
		beforeReclaimRename?: () => void;
	},
): boolean {
	const observed = staleObservation(lockDir, options);
	if (!observed) return false;
	options.beforeReclaimRename?.();
	const staleDir = `${lockDir}.stale.${process.pid}.${options.now()}.${randomUUID()}`;
	try {
		renameSync(lockDir, staleDir);
	} catch (error) {
		if (errno(error, "ENOENT")) return true;
		throw error;
	}
	if (!observationMatches(staleDir, observed)) {
		// ABA fence: another contender replaced the observed stale owner before
		// our rename. Never delete the moved successor. Restore it when the
		// canonical path is still free; otherwise leave the fenced directory for
		// its owner to observe loss and abort before any credential write.
		try {
			renameSync(staleDir, lockDir);
		} catch (error) {
			if (!errno(error, "EEXIST")) throw error;
		}
		return false;
	}
	rmSync(staleDir, { recursive: true, force: true });
	return true;
}

function releaseOwnedLock(lockDir: string, token: string): void {
	// A stale-owner takeover replaces owner.json with a new random token. Never
	// remove that successor's directory when the old process eventually wakes.
	if (readOwner(lockDir)?.token !== token) return;
	rmSync(lockDir, { recursive: true, force: true });
}

function sleepSync(milliseconds: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function withPrivateDirectoryLockSync<T>(
	lockDir: string,
	fn: (lease: PrivateDirectoryLockLease) => T,
	options: PrivateDirectoryLockOptions = {},
): T {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
	const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
	const now = options.now ?? Date.now;
	const alive = options.isProcessAlive ?? processIsAlive;
	const parent = dirname(lockDir);
	mkdirSync(parent, { recursive: true, mode: PRIVATE_DIR_MODE });
	try {
		chmodSync(parent, PRIVATE_DIR_MODE);
	} catch {
		// Best effort on platforms that do not implement POSIX permissions.
	}

	const startedAt = now();
	const token = randomUUID();
	for (;;) {
		try {
			mkdirSync(lockDir, { mode: PRIVATE_DIR_MODE });
			try {
				writePrivateFileAtomic(
					ownerPath(lockDir),
					`${JSON.stringify({
						schemaVersion: "clawdi.privateDirectoryLockOwner.v1",
						pid: process.pid,
						acquiredAt: new Date(now()).toISOString(),
						token,
					})}\n`,
					{ mode: PRIVATE_FILE_MODE, dirMode: PRIVATE_DIR_MODE },
				);
			} catch (error) {
				rmSync(lockDir, { recursive: true, force: true });
				throw error;
			}
			break;
		} catch (error) {
			if (!errno(error, "EEXIST")) throw error;
			if (
				reclaimStaleLock(lockDir, {
					staleMs,
					now,
					isProcessAlive: alive,
					beforeReclaimRename: options.beforeReclaimRename,
				})
			) {
				continue;
			}
			if (now() - startedAt >= timeoutMs) {
				throw new Error(`timed out waiting for private lock at ${lockDir}`);
			}
			sleepSync(retryMs);
		}
	}

	const lease: PrivateDirectoryLockLease = {
		token,
		assertOwned() {
			if (readOwner(lockDir)?.token !== token) {
				throw new Error(`lost ownership of private lock at ${lockDir}`);
			}
		},
	};
	try {
		lease.assertOwned();
		return fn(lease);
	} finally {
		releaseOwnedLock(lockDir, token);
	}
}

export async function withPrivateDirectoryLock<T>(
	lockDir: string,
	fn: (lease: PrivateDirectoryLockLease) => Promise<T>,
	options: PrivateDirectoryLockOptions = {},
): Promise<T> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
	const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
	const now = options.now ?? Date.now;
	const alive = options.isProcessAlive ?? processIsAlive;
	const parent = dirname(lockDir);
	mkdirSync(parent, { recursive: true, mode: PRIVATE_DIR_MODE });
	try {
		chmodSync(parent, PRIVATE_DIR_MODE);
	} catch {
		// Best effort on platforms that do not implement POSIX permissions.
	}

	const startedAt = now();
	const token = randomUUID();
	for (;;) {
		try {
			mkdirSync(lockDir, { mode: PRIVATE_DIR_MODE });
			try {
				const owner: LockOwner = {
					schemaVersion: "clawdi.privateDirectoryLockOwner.v1",
					pid: process.pid,
					acquiredAt: new Date(now()).toISOString(),
					token,
				};
				writePrivateFileAtomic(ownerPath(lockDir), `${JSON.stringify(owner)}\n`, {
					mode: PRIVATE_FILE_MODE,
					dirMode: PRIVATE_DIR_MODE,
				});
			} catch (error) {
				rmSync(lockDir, { recursive: true, force: true });
				throw error;
			}
			break;
		} catch (error) {
			if (!errno(error, "EEXIST")) throw error;
			if (
				reclaimStaleLock(lockDir, {
					staleMs,
					now,
					isProcessAlive: alive,
					beforeReclaimRename: options.beforeReclaimRename,
				})
			) {
				continue;
			}
			if (now() - startedAt >= timeoutMs) {
				throw new PrivateDirectoryLockTimeoutError(lockDir);
			}
			await new Promise((resolve) => setTimeout(resolve, retryMs));
		}
	}

	const lease: PrivateDirectoryLockLease = {
		token,
		assertOwned() {
			if (readOwner(lockDir)?.token !== token) {
				throw new Error(`lost ownership of private lock at ${lockDir}`);
			}
		},
	};
	try {
		lease.assertOwned();
		return await fn(lease);
	} finally {
		releaseOwnedLock(lockDir, token);
	}
}
