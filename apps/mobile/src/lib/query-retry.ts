import { ApiClientError, ApiClientNetworkError } from "@clawdi/shared/api";

const MAX_RETRY_DELAY_MS = 30_000;

/**
 * Web `billingQueryRetry` parity for shared-client reads. Transient failures (offline,
 * timeout, 5xx and 429, e.g. hosted `request_temporarily_busy` while a first sign-in
 * fans out) are retried before they render as a definitive error. Deterministic 4xx
 * and account-scope fences surface on the first attempt.
 */
function retryTransientFailure(failureCount: number, error: unknown): boolean {
	if (error instanceof ApiClientNetworkError) return failureCount < 3;
	return (
		failureCount < 2 &&
		error instanceof ApiClientError &&
		(error.category === "server" || error.category === "rate_limited")
	);
}

/** Honours the server's `Retry-After`; otherwise TanStack Query's default backoff. */
function transientRetryDelay(failureCount: number, error: unknown): number {
	if (error instanceof ApiClientError && error.retryAfterMs !== null)
		return Math.min(error.retryAfterMs, MAX_RETRY_DELAY_MS);
	return Math.min(1000 * 2 ** failureCount, MAX_RETRY_DELAY_MS);
}

export const transientQueryRetry = {
	retry: retryTransientFailure,
	retryDelay: transientRetryDelay,
} as const;
