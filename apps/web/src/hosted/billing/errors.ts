/**
 * Error handling for the hosted billing API.
 *
 * The deploy/cloud-api backend raises FastAPI `HTTPException`s whose body is
 * `{ "detail": "<message-or-code>" }`. This module captures the status + the
 * parsed detail, and normalizes the user-facing copy for hosted billing cases:
 * most importantly the managed-AI balance-exhausted 403, which
 * must read as "insufficient balance / top up", never a raw gateway error
 * from the upstream provider.
 */

import { toast } from "sonner";
import type {
	WalletComputeConflictError,
	WalletComputeErrorDetail,
	WalletComputeInsufficientError,
	WalletComputeUpstreamError,
} from "@/hosted/billing/contracts";

export class BillingApiError extends Error {
	constructor(
		public status: number,
		/** Parsed `detail` string (or the raw status text). */
		public detail: string,
		/** Original OpenAPI error payload when the client returned one. */
		public payload?: unknown,
	) {
		super(`Billing API ${status}: ${detail}`);
		this.name = "BillingApiError";
	}

	static async fromResponse(response: Response): Promise<BillingApiError> {
		let detail = response.statusText;
		let payload: unknown;
		try {
			const body: unknown = await response.json();
			payload = body;
			if (hasDetail(body) && typeof body.detail === "string") {
				detail = body.detail;
			} else if (hasDetail(body) && body.detail != null) {
				detail = JSON.stringify(body.detail);
			}
		} catch {
			// Non-JSON body (proxy/gateway error page) — keep statusText.
		}
		return new BillingApiError(response.status, detail, payload);
	}
}

function hasDetail(value: unknown): value is { detail: unknown } {
	return typeof value === "object" && value !== null && "detail" in value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Structured FastAPI detail object, when one was returned. */
export function billingErrorDetail(error: unknown): Record<string, unknown> | null {
	if (!(error instanceof BillingApiError)) return null;
	if (hasDetail(error.payload) && isRecord(error.payload.detail)) return error.payload.detail;
	if (isRecord(error.payload)) return error.payload;
	try {
		const parsed: unknown = JSON.parse(error.detail);
		if (hasDetail(parsed) && isRecord(parsed.detail)) return parsed.detail;
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function isWalletComputeInsufficientDetail(
	value: Record<string, unknown>,
): value is WalletComputeInsufficientError["detail"] {
	return (
		value.code === "insufficient_wallet_balance" &&
		typeof value.required_credits === "string" &&
		typeof value.available_credits === "string" &&
		typeof value.shortfall_credits === "string"
	);
}

function isWalletComputeUpstreamDetail(
	value: Record<string, unknown>,
): value is WalletComputeUpstreamError["detail"] {
	return (
		(value.code === "wallet_balance_refresh_failed" ||
			value.code === "wallet_compute_charge_failed" ||
			value.code === "wallet_compute_upstream_failed") &&
		value.retryable === true &&
		(value.failure_code === undefined ||
			value.failure_code === null ||
			typeof value.failure_code === "string")
	);
}

function isWalletComputeConflictDetail(
	value: Record<string, unknown>,
): value is Exclude<WalletComputeConflictError["detail"], string> {
	return (
		value.code === "deploy_request_funding_conflict" ||
		value.code === "idempotency_key_reused" ||
		value.code === "open_refund_debt" ||
		(typeof value.code === "string" && value.retryable === true)
	);
}

/** Generated wallet-compute business error detail, validated at the HTTP boundary. */
export function walletComputeErrorDetail(error: unknown): WalletComputeErrorDetail | null {
	const detail = billingErrorDetail(error);
	if (!detail) return null;
	if (isWalletComputeInsufficientDetail(detail)) return detail;
	if (isWalletComputeUpstreamDetail(detail)) return detail;
	if (isWalletComputeConflictDetail(detail)) return detail;
	return null;
}

/**
 * Transport-level failure (the request never produced an HTTP response):
 * the network is down, DNS failed, the API host is unreachable, or our
 * client-side timeout aborted the request. Distinct from `BillingApiError`
 * (which always carries a real status) so the UI can show a "check your
 * connection / try again" recovery path instead of a raw status message.
 */
export class BillingNetworkError extends Error {
	constructor(
		public readonly kind: "timeout" | "offline",
		options?: { cause?: unknown },
	) {
		super(kind === "timeout" ? "Billing API request timed out" : "Billing API request failed");
		this.name = "BillingNetworkError";
		if (options?.cause !== undefined) this.cause = options.cause;
	}
}

/** Auth expired / invalid token mid-session (401). Needs re-auth, not a retry. */
export function isAuthError(error: unknown): boolean {
	return error instanceof BillingApiError && error.status === 401;
}

/** Authenticated but not permitted (403) — distinct from a 401 re-auth case. */
export function isForbiddenError(error: unknown): boolean {
	return error instanceof BillingApiError && error.status === 403;
}

/** Backend fault (5xx) or rate-limit (429) — transient; safe to retry. */
export function isServerError(error: unknown): boolean {
	return error instanceof BillingApiError && (error.status >= 500 || error.status === 429);
}

/** True when the request never reached the server (offline / DNS / timeout). */
export function isNetworkError(error: unknown): boolean {
	return error instanceof BillingNetworkError;
}

/**
 * Whether an automatic retry could plausibly succeed. Network blips, timeouts,
 * 5xx, and 429 are transient; 4xx (auth, validation, not-found, conflict) are
 * deterministic and must surface immediately instead of retrying three times.
 */
export function isRetryableError(error: unknown): boolean {
	return isNetworkError(error) || isServerError(error);
}

/**
 * Shared TanStack Query `retry` predicate for the billing surfaces. Lets
 * deterministic 4xx (validation errors, auth, not-found, conflict) fall
 * through on the first attempt so their tailored UI shows without a
 * multi-second spinner.
 *
 * Network errors get a longer budget (~7s of backoff) than 5xx/429 (~3s):
 * every backend deploy swaps containers behind the proxy, and for a few
 * seconds the proxy answers with its own CORS-less 502, which the browser
 * can only see as a fetch failure. Two retries give up inside that window
 * and strand the error banner on a service that is already healthy again.
 */
export function billingQueryRetry(failureCount: number, error: unknown): boolean {
	if (isNetworkError(error)) return failureCount < 3;
	return failureCount < 2 && isRetryableError(error);
}

const INSUFFICIENT_BALANCE_PATTERNS = [
	/insufficient[_\s-]?balance/i,
	/insufficient funds/i,
	/balance.*(too low|exhausted|depleted)/i,
];

/**
 * Detect the managed-AI balance-exhausted condition. The gateway emits a 403
 * `INSUFFICIENT_BALANCE`; cloud-api may also surface it as a detail string.
 * Used to swap in the normalized "top up / enable auto-reload" UX.
 */
export function isInsufficientBalanceError(error: unknown): boolean {
	if (!(error instanceof BillingApiError)) return false;
	if (error.status !== 403 && error.status !== 402) return false;
	return INSUFFICIENT_BALANCE_PATTERNS.some((re) => re.test(error.detail));
}

/**
 * Turn an API error into a single user-facing sentence. Hides backend
 * internals; normalizes balance exhaustion to the product narrative.
 */
export function normalizeBillingError(error: unknown): string {
	if (isInsufficientBalanceError(error)) {
		return "Your AI Credits balance is too low. Top up or enable auto-reload before managed AI or wallet-funded compute is interrupted.";
	}
	if (error instanceof BillingNetworkError) {
		return error.kind === "timeout"
			? "This is taking longer than usual. Check your connection and try again."
			: "We couldn't reach the billing service. Check your connection and try again.";
	}
	if (isAuthError(error)) {
		return "Your session has expired. Please sign in again to continue.";
	}
	if (isServerError(error)) {
		return "The billing service is having trouble right now. Please try again in a moment.";
	}
	if (error instanceof BillingApiError) {
		const code = billingErrorDetail(error)?.code;
		if (code === "open_refund_debt") {
			return "A wallet refund is still settling. Try again after it completes.";
		}
		if (code === "deploy_request_funding_conflict") {
			return "This deploy request is already linked to a different payment flow.";
		}
		if (code === "idempotency_key_reused") {
			return "This payment request conflicts with an earlier attempt. Refresh and try again.";
		}
		if (typeof code === "string") {
			return "The billing request could not be completed. Refresh and try again.";
		}
		// Snake_case error codes → readable text; pass through real sentences.
		if (/^[a-z0-9_]+$/.test(error.detail)) {
			return error.detail.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
		}
		return error.detail;
	}
	if (error instanceof Error) return error.message;
	return "Something went wrong. Please try again.";
}

/**
 * Mutation `onError` handler for billing-client hooks: toast `title` with the
 * normalized, product-narrative billing copy as the description.
 */
export function toastBillingError(title: string) {
	return (error: unknown) => toast.error(title, { description: normalizeBillingError(error) });
}

export const billingErrorNormalizer = {
	isAuthError,
	normalizeError: normalizeBillingError,
};
