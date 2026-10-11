import { ACCOUNT_SUSPENDED_CODE } from "./account-suspension";

/**
 * A platform-neutral reading of a failed request. Each app maps its own error classes:
 * `timeout`/`offline` never reached the server, `response` carries the HTTP answer and
 * its user-facing `detail` sentence, `error` is any other thrown Error.
 */
export type RequestFailure =
	| { kind: "timeout" | "offline" }
	| { kind: "response"; status: number; code?: string | null; detail?: string | null }
	| { kind: "error" | "unknown" };

export const API_ERROR_COPY = {
	errorTitle: "Couldn't load this",
	expiredTitle: "Your session expired",
	signInAgain: "Sign in again",
	retry: "Retry",
	expired: "Your session expired. Sign in again to continue.",
	suspended: "Your account has been deactivated and can no longer access Clawdi.",
	timeout: "This is taking longer than usual. Check your connection and try again.",
	offline: "We couldn't reach the service. Check your connection and try again.",
	serviceError: "The service is having trouble right now. Try again in a moment.",
	requestError: "The request couldn't be completed. Review the details and try again.",
	genericError: "Couldn't complete the request. Try again.",
} as const;

/** Cloud answers a suspended account with 401 and hosted with 403; both carry the same code. */
export function isAccountSuspendedFailure(failure: RequestFailure): boolean {
	return (
		failure.kind === "response" &&
		(failure.status === 401 || failure.status === 403) &&
		failure.code === ACCOUNT_SUSPENDED_CODE
	);
}

/** A bare snake_case token is an internal error code, not product copy. */
export function isInternalErrorCode(value: string): boolean {
	return /^[a-z0-9_]+$/.test(value);
}

/**
 * One user-facing sentence for a failed request: hides 5xx/gateway internals, reads a 401
 * as a re-auth prompt, and passes a server sentence through unless it is an internal code.
 */
export function apiErrorCopy(failure: RequestFailure): string {
	if (failure.kind === "timeout") return API_ERROR_COPY.timeout;
	if (failure.kind === "offline") return API_ERROR_COPY.offline;
	if (failure.kind !== "response") return API_ERROR_COPY.genericError;
	if (isAccountSuspendedFailure(failure)) return API_ERROR_COPY.suspended;
	if (failure.status === 401) return API_ERROR_COPY.expired;
	if (failure.status >= 500 || failure.status === 429) return API_ERROR_COPY.serviceError;
	const detail = failure.detail?.trim();
	return detail && !isInternalErrorCode(detail) ? detail : API_ERROR_COPY.requestError;
}
