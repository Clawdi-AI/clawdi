/** Largest millisecond delay that can be represented as an exact JavaScript integer. */
export const MAX_SAFE_RETRY_AFTER_MS = Number.MAX_SAFE_INTEGER;

const HTTP_DATE_PATTERN = new RegExp(
	"^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \\d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \\d{4} \\d{2}:\\d{2}:\\d{2} GMT|" +
		"(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \\d{2}-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\\d{2} \\d{2}:\\d{2}:\\d{2} GMT|" +
		"(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?:\\d{2}| \\d) \\d{2}:\\d{2}:\\d{2} \\d{4})$",
);

/** Parse RFC Retry-After (delta-seconds or HTTP-date) into milliseconds. */
export function parseRetryAfter(
	value: string | null,
	options: { now?: number; maxMs?: number } = {},
): number | null {
	if (value === null) return null;
	const raw = value.trim();
	if (!raw) return null;
	const maxMs = options.maxMs ?? MAX_SAFE_RETRY_AFTER_MS;
	if (!Number.isSafeInteger(maxMs) || maxMs < 0) {
		throw new RangeError("Retry-After maxMs must be a non-negative safe integer");
	}

	if (/^\d+$/.test(raw)) {
		// Parse as bigint so an arbitrarily large but valid delta never becomes
		// Infinity or gets mistaken for a malformed header. The caller-supplied
		// bound (or exact-integer representation limit) is applied afterwards.
		const delayMs = BigInt(raw) * 1000n;
		return delayMs > BigInt(maxMs) ? maxMs : Number(delayMs);
	}

	if (!HTTP_DATE_PATTERN.test(raw)) return null;
	const timestamp = Date.parse(raw);
	if (!Number.isFinite(timestamp)) return null;
	const delayMs = timestamp - (options.now ?? Date.now());
	if (!Number.isFinite(delayMs)) return null;
	return Math.min(Math.max(0, delayMs), maxMs);
}
