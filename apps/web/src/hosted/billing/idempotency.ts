/**
 * A best-effort idempotency key for a mutating billing request.
 *
 * Reuse one key across every retry of the SAME logical attempt (a timeout
 * re-submit, a double-tab, a fast double-click) so the backend collapses the
 * duplicate instead of charging / granting twice. Generate a fresh key only
 * when the user starts a genuinely new attempt.
 */
export function newIdempotencyKey(prefix: string): string {
	if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
		return `${prefix}-${crypto.randomUUID()}`;
	}
	return `${prefix}-${Date.now()}`;
}

export type IdempotencyAttempt = {
	createdAt?: number;
	fingerprint: string;
	key: string;
};

type MintIdempotencyKey = (prefix: string) => string;

export const IDEMPOTENCY_ATTEMPT_TTL_MS = 30 * 60_000;

const IDEMPOTENCY_STORAGE_KEY = "clawdi:idempotency-attempts";

type StoredAttempt = {
	key: string;
	createdAt: number;
};

type StoredAttempts = Record<string, StoredAttempt>;

type IdempotencyPersistenceOptions = {
	now?: () => number;
	storage?: Storage | null;
	ttlMs?: number;
};

function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableValue);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, next]) => [key, stableValue(next)]),
	);
}

export function idempotencyFingerprint(value: unknown): string {
	return JSON.stringify(stableValue(value));
}

function storageEntryKey(prefix: string, fingerprint: string): string {
	return `${prefix}:${fingerprint}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isStoredAttempt(value: unknown): value is StoredAttempt {
	return (
		isRecord(value) &&
		typeof value.key === "string" &&
		typeof value.createdAt === "number" &&
		Number.isFinite(value.createdAt)
	);
}

function readStoredAttempts(storage: Storage, now: number, ttlMs: number): StoredAttempts | null {
	let raw: string | null;
	try {
		raw = storage.getItem(IDEMPOTENCY_STORAGE_KEY);
	} catch {
		return null;
	}
	if (!raw) return {};

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		try {
			storage.removeItem(IDEMPOTENCY_STORAGE_KEY);
		} catch {
			// Ignore storage failures; idempotency still falls back to a fresh key.
		}
		return {};
	}

	if (!isRecord(parsed)) return {};

	const attempts: StoredAttempts = {};
	let changed = false;
	for (const [key, value] of Object.entries(parsed)) {
		if (!isStoredAttempt(value)) {
			changed = true;
			continue;
		}
		if (now - value.createdAt > ttlMs) {
			changed = true;
			continue;
		}
		attempts[key] = value;
	}

	if (changed) {
		writeStoredAttempts(storage, attempts);
	}
	return attempts;
}

function writeStoredAttempts(storage: Storage, attempts: StoredAttempts): boolean {
	try {
		storage.setItem(IDEMPOTENCY_STORAGE_KEY, JSON.stringify(attempts));
		return true;
	} catch {
		// Storage can be unavailable, full, or denied. The caller still receives
		// a key, but remount persistence is best-effort in that environment.
		return false;
	}
}

function browserSessionStorage(): Storage | null {
	if (typeof window === "undefined") return null;
	try {
		return window.sessionStorage ?? null;
	} catch {
		return null;
	}
}

export function idempotencyAttemptFor(
	current: IdempotencyAttempt | null,
	prefix: string,
	fingerprint: string,
	mintKey: MintIdempotencyKey = newIdempotencyKey,
	options: IdempotencyPersistenceOptions = {},
): IdempotencyAttempt {
	const now = options.now?.() ?? Date.now();
	const ttlMs = options.ttlMs ?? IDEMPOTENCY_ATTEMPT_TTL_MS;
	const storage = options.storage === undefined ? browserSessionStorage() : options.storage;
	const freshCurrent =
		current?.fingerprint === fingerprint &&
		(current.createdAt === undefined || now - current.createdAt <= ttlMs)
			? current
			: null;

	if (storage) {
		const entryKey = storageEntryKey(prefix, fingerprint);
		const attempts = readStoredAttempts(storage, now, ttlMs);
		if (!attempts) {
			if (freshCurrent) return freshCurrent;
			return { createdAt: now, fingerprint, key: mintKey(prefix) };
		}
		const persisted = attempts[entryKey];
		if (persisted) {
			if (freshCurrent && freshCurrent.key === persisted.key) return freshCurrent;
			return { createdAt: persisted.createdAt, fingerprint, key: persisted.key };
		}

		const attempt = freshCurrent ?? { createdAt: now, fingerprint, key: mintKey(prefix) };
		attempts[entryKey] = { key: attempt.key, createdAt: attempt.createdAt ?? now };
		writeStoredAttempts(storage, attempts);
		return attempt;
	}

	if (freshCurrent) return freshCurrent;
	return { createdAt: now, fingerprint, key: mintKey(prefix) };
}

/** Remove a completed logical attempt so a later identical action is new. */
export function forgetIdempotencyAttempt(
	prefix: string,
	fingerprint: string,
	options: IdempotencyPersistenceOptions = {},
): void {
	const storage = options.storage === undefined ? browserSessionStorage() : options.storage;
	if (!storage) return;
	const now = options.now?.() ?? Date.now();
	const ttlMs = options.ttlMs ?? IDEMPOTENCY_ATTEMPT_TTL_MS;
	const attempts = readStoredAttempts(storage, now, ttlMs);
	if (!attempts) return;
	const entryKey = storageEntryKey(prefix, fingerprint);
	if (!(entryKey in attempts)) return;
	delete attempts[entryKey];
	writeStoredAttempts(storage, attempts);
}
