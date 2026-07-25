import { QueryClient, replaceEqualDeep } from "@tanstack/react-query";
import { ApiError } from "@/lib/api-errors";
import { sanitizeQueryCacheValue } from "@/lib/sensitive-cache";

export function createAppQueryClient(): QueryClient {
	return new QueryClient({
		defaultOptions: {
			queries: {
				staleTime: 30_000,
				// API payloads are sanitized before QueryCache owns them. This is
				// structural prevention: a client secret is never briefly cached and
				// then cleaned up after observers/devtools have seen it.
				structuralSharing: (oldData, newData) =>
					replaceEqualDeep(oldData, sanitizeQueryCacheValue(newData)),
				retry: (failureCount, error) => {
					if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
						return false;
					}
					// Fetch-level failures (no HTTP response) get a longer budget
					// (~7s of backoff) than server errors (~3s): backend deploys
					// swap containers behind the proxy, and for a few seconds the
					// proxy answers with its own CORS-less 502, which the browser
					// can only see as a fetch failure.
					if (!(error instanceof ApiError)) {
						return failureCount < 3;
					}
					return failureCount < 2;
				},
			},
		},
	});
}
