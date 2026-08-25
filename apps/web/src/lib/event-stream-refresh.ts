export const EVENT_STREAM_POLL_FALLBACK_MULTIPLIER = 10;

export function eventStreamFallbackInterval(interval: number, streamActive: boolean): number;
export function eventStreamFallbackInterval(interval: false, streamActive: boolean): false;
export function eventStreamFallbackInterval(
	interval: number | false,
	streamActive: boolean,
): number | false;
export function eventStreamFallbackInterval(
	interval: number | false,
	streamActive: boolean,
): number | false {
	return typeof interval === "number" && streamActive
		? interval * EVENT_STREAM_POLL_FALLBACK_MULTIPLIER
		: interval;
}
