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
