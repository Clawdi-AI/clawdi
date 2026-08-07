import { ApiError, ApiNetworkError, isApiNetworkError, isApiServerError } from "@/lib/api-errors";

/** Keep the capability check bounded like the main API and billing clients. */
export const HOSTED_PRODUCT_ACCESS_TIMEOUT_MS = 20_000;

type FetchImplementation = (request: Request, init?: RequestInit) => Promise<Response>;

type TimeoutFetchOptions = {
	fetch?: FetchImplementation;
	timeoutMs?: number;
};

/**
 * Capability-specific copy of the application's bounded-fetch transport.
 * Caller cancellation stays distinguishable from the timeout owned here.
 */
export function fetchHostedProductAccessWithTimeout(
	request: Request,
	init?: RequestInit,
	options: TimeoutFetchOptions = {},
): Promise<Response> {
	const caller = init?.signal ?? request.signal;
	const controller = new AbortController();
	const fetchImplementation = options.fetch ?? fetch;
	let timedOut = false;
	const onAbort = () => controller.abort();
	if (caller?.aborted) {
		controller.abort();
	} else {
		caller?.addEventListener("abort", onAbort, { once: true });
	}
	const timeoutId = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, options.timeoutMs ?? HOSTED_PRODUCT_ACCESS_TIMEOUT_MS);

	return fetchImplementation(request, { ...init, signal: controller.signal })
		.catch((cause: unknown) => {
			if (timedOut) throw new ApiNetworkError("timeout", { cause });
			if (caller?.aborted) throw cause;
			throw new ApiNetworkError("offline", { cause });
		})
		.finally(() => {
			clearTimeout(timeoutId);
			caller?.removeEventListener("abort", onAbort);
		});
}

/**
 * Retry transient transport/server failures twice. A single 401 is also
 * retried because each attempt asks the auth provider for a fresh token.
 */
export function hostedProductAccessRetry(failureCount: number, error: unknown): boolean {
	if (error instanceof ApiError && error.status === 401) return failureCount < 1;
	return failureCount < 2 && (isApiNetworkError(error) || isApiServerError(error));
}
