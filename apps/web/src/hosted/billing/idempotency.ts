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
	fingerprint: string;
	key: string;
};

type MintIdempotencyKey = (prefix: string) => string;

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

export function idempotencyAttemptFor(
	current: IdempotencyAttempt | null,
	prefix: string,
	fingerprint: string,
	mintKey: MintIdempotencyKey = newIdempotencyKey,
): IdempotencyAttempt {
	if (current?.fingerprint === fingerprint) return current;
	return { fingerprint, key: mintKey(prefix) };
}
