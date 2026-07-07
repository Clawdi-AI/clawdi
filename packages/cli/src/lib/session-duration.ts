export function durationSecondsBetween(startedAt: Date, endedAt: Date | null): number | null {
	if (!endedAt) return null;
	return Math.max(0, Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000));
}
