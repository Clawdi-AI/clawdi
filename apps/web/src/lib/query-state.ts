/**
 * TanStack Query retains successful data when a later refetch fails. Treat the
 * error as blocking only when there is no usable cache entry to keep rendering.
 */
export function shouldBlockQueryError(error: unknown, data: unknown): boolean {
	return error !== null && error !== undefined && data === undefined;
}
