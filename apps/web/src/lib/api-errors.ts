import { toast } from "sonner";

/**
 * Cloud-api (`useApi` / openapi-fetch) error model + normalization.
 *
 * The cloud-api backend raises FastAPI `HTTPException`s whose body is
 * `{ "detail": "<message-or-code>" }`. `ApiError` captures the status + parsed
 * detail; `ApiNetworkError` covers transport failures (offline / our own
 * client-side timeout abort). `normalizeApiError` turns either into a single,
 * user-facing sentence — hiding raw 5xx/gateway internals and reading a 401 as
 * "sign in again" — mirroring the hosted billing surfaces' error handling.
 */

export class ApiError extends Error {
	constructor(
		public status: number,
		public detail: string,
	) {
		super(`API ${status}: ${detail}`);
		this.name = "ApiError";
	}
}

/**
 * Transport-level failure: the request never produced an HTTP response (the
 * network is down, DNS failed, the host is unreachable, or our client-side
 * timeout aborted it). Distinct from `ApiError` (which always carries a real
 * status) so the UI can offer a "check your connection / try again" path
 * instead of a raw status message.
 */
export class ApiNetworkError extends Error {
	constructor(
		public readonly kind: "timeout" | "offline",
		options?: { cause?: unknown },
	) {
		super(kind === "timeout" ? "API request timed out" : "API request failed");
		this.name = "ApiNetworkError";
		if (options?.cause !== undefined) this.cause = options.cause;
	}
}

export function parseApiDetail(detail: string): unknown {
	try {
		const body = JSON.parse(detail) as { detail?: unknown };
		return body.detail ?? body;
	} catch {
		return detail;
	}
}

export function formatApiError(detail: string): string {
	const parsed = parseApiDetail(detail);
	if (typeof parsed === "string") return parsed;
	if (typeof parsed === "object" && parsed !== null && "message" in parsed) {
		const message = (parsed as { message?: unknown }).message;
		if (typeof message === "string") return message;
	}
	return detail;
}

/** Auth expired / invalid token mid-session (401). Needs re-auth, not a retry. */
export function isApiAuthError(error: unknown): boolean {
	return error instanceof ApiError && error.status === 401;
}

/** Backend fault (5xx) or rate-limit (429) — transient; safe to retry. */
export function isApiServerError(error: unknown): boolean {
	return error instanceof ApiError && (error.status >= 500 || error.status === 429);
}

/** True when the request never reached the server (offline / DNS / timeout). */
export function isApiNetworkError(error: unknown): boolean {
	return error instanceof ApiNetworkError;
}

/**
 * Turn a cloud-api error into a single user-facing sentence. Hides backend
 * internals (raw 5xx/gateway bodies), reads a 401 as a re-auth prompt, and
 * makes snake_case error codes readable while passing real sentences through.
 */
export function normalizeApiError(error: unknown): string {
	if (error instanceof ApiNetworkError) {
		return error.kind === "timeout"
			? "This is taking longer than usual. Check your connection and try again."
			: "We couldn't reach the service. Check your connection and try again.";
	}
	if (error instanceof ApiError) {
		if (error.status === 401) {
			return "Your session has expired. Please sign in again to continue.";
		}
		if (error.status >= 500 || error.status === 429) {
			return "The service is having trouble right now. Please try again in a moment.";
		}
		const message = formatApiError(error.detail);
		// Snake_case codes → readable text; pass through real sentences.
		if (/^[a-z0-9_]+$/.test(message)) {
			return message.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
		}
		return message;
	}
	if (error instanceof Error) return error.message;
	return "Something went wrong. Please try again.";
}

/**
 * Mutation `onError` handler for cloud-api (`useApi`) hooks: toast `title` with
 * the normalized, internal-free error copy as the description.
 */
export function toastApiError(title: string) {
	return (error: unknown) => toast.error(title, { description: normalizeApiError(error) });
}
