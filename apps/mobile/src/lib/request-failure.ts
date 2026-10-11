import { ApiClientError, ApiClientNetworkError } from "@clawdi/shared/api";
import type { RequestFailure } from "@clawdi/shared/view";

/**
 * The shared client's error boundary, read for the shared Web error copy. The client
 * keeps only the status and code, never the server's detail text.
 */
export function requestFailure(error: unknown): RequestFailure {
	if (error instanceof ApiClientNetworkError) return { kind: error.kind };
	if (error instanceof ApiClientError) {
		return { kind: "response", status: error.status, code: error.code };
	}
	return { kind: error instanceof Error ? "error" : "unknown" };
}
