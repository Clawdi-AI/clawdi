const MAX_RETRY_AFTER_MS = 5 * 60 * 1000;

/** Parse RFC Retry-After (delta-seconds or HTTP-date) into a bounded delay. */
export function parseRetryAfter(
	value: string | null,
	options: { now?: number; maxMs?: number } = {},
): number | null {
	if (value === null) return null;
	const raw = value.trim();
	if (!raw) return null;

	let delayMs: number;
	if (/^\d+$/.test(raw)) {
		delayMs = Number(raw) * 1000;
	} else {
		const timestamp = Date.parse(raw);
		if (!Number.isFinite(timestamp)) return null;
		delayMs = timestamp - (options.now ?? Date.now());
	}

	if (!Number.isFinite(delayMs) || delayMs <= 0) return null;
	return Math.min(delayMs, options.maxMs ?? MAX_RETRY_AFTER_MS);
}
