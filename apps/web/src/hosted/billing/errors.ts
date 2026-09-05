/**
 * Error handling for the hosted billing API.
 *
 * The deploy/cloud-api backend raises FastAPI `HTTPException`s whose body is
 * `{ "detail": "<message-or-code>" }`. This module captures the status + the
 * parsed detail, and normalizes the user-facing copy for hosted billing cases:
 * most importantly the managed-AI balance-exhausted 402, which
 * must read as "insufficient balance / top up", never a raw gateway error
 * from the upstream provider.
 */

import { toast } from "sonner";
import type {
	ComputePlanChangeFundingSource,
	ComputePlanChangeKind,
	HostedDeployRequestStatus,
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

export const DEPLOYMENT_CONFLICT_MESSAGE =
	"This agent changed in another session. We refreshed it; review the latest state and try again.";

/** A declarative mutation still conflicted after its single fresh-read retry. */
export class DeploymentConflictError extends Error {
	constructor(options?: { cause?: unknown }) {
		super(DEPLOYMENT_CONFLICT_MESSAGE);
		this.name = "DeploymentConflictError";
		if (options?.cause !== undefined) this.cause = options.cause;
	}
}

/** A checkout-funded deploy request reached an explicit terminal state. */
export class DeploymentRequestTerminalError extends BillingApiError {
	override name = "DeploymentRequestTerminalError";

	constructor(
		public readonly request: HostedDeployRequestStatus,
		detail: string,
	) {
		super(409, detail, request);
	}
}

export type DeploymentRequestTerminalOutcome =
	| { kind: "open_deployment"; deploymentId: string }
	| {
			kind: "new_attempt" | "review_agents" | "trial_ineligible";
			title: string;
			description: string;
	  };

export function deploymentRequestTerminalOutcome(
	error: unknown,
): DeploymentRequestTerminalOutcome | null {
	if (!(error instanceof DeploymentRequestTerminalError)) return null;
	const requestStatus = error.request.request_status;
	const deploymentId = error.request.lineage_tail?.deployment_id?.trim();
	if (deploymentId) {
		return { kind: "open_deployment", deploymentId };
	}
	if (error.request.failure_code === "trial_ineligible") {
		return {
			kind: "trial_ineligible",
			title: "Free trial unavailable",
			description:
				"This payment method isn’t eligible for a free trial. You can still deploy at the regular price.",
		};
	}
	if (requestStatus === "superseded") {
		return {
			kind: "review_agents",
			title: "Checkout was replaced",
			description:
				"A newer checkout attempt replaced this agent request. Review your agents before starting another checkout.",
		};
	}
	return {
		kind: "new_attempt",
		title: requestStatus === "expired" ? "Agent request expired" : "Agent creation failed",
		description:
			"No agent was accepted from this checkout. Review your choices and start a new checkout when you’re ready.",
	};
}

/** A plan change remains nonterminal after the bounded foreground poll. */
export class PlanChangePendingError extends Error {
	constructor(public readonly operationName: string) {
		super("We're still waiting for the subscription change to finish. Check again in a moment.");
		this.name = "PlanChangePendingError";
	}
}

/** The accepted plan change reached an explicit failed terminal state. */
export class PlanChangeTerminalError extends BillingApiError {
	override name = "PlanChangeTerminalError";

	constructor(
		status: number,
		detail: string,
		payload?: unknown,
		public readonly changeKind: ComputePlanChangeKind | null = null,
		public readonly fundingSource: ComputePlanChangeFundingSource | null = null,
		public readonly operationName: string | null = null,
	) {
		super(status, detail, payload);
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

export function isIdempotencyKeyReusedError(error: unknown): boolean {
	return billingErrorDetail(error)?.code === "idempotency_key_reused";
}

export function isReusableSubscriptionUnavailableError(error: unknown): boolean {
	return (
		error instanceof BillingApiError &&
		error.status === 409 &&
		billingErrorDetail(error)?.code === "reusable_subscription_unavailable"
	);
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
export function isNetworkError(error: unknown): error is BillingNetworkError {
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

export type DeploySubmissionContext =
	| "card_checkout"
	| "included_creation"
	| "subscription_assignment"
	| "wallet_creation";

export type DeploySubmissionErrorPresentation = {
	description: string;
	title: string;
};

function isDefinitiveBillingRejection(error: unknown): boolean {
	return (
		error instanceof BillingApiError &&
		error.status >= 400 &&
		error.status < 500 &&
		error.status !== 429
	);
}

/** Only return copy backed by a known public billing condition. */
function knownBillingRecovery(error: unknown): string | null {
	if (error instanceof DeploymentConflictError) return DEPLOYMENT_CONFLICT_MESSAGE;
	if (isInsufficientBalanceError(error)) return normalizeBillingError(error);
	if (isAuthError(error)) return "Your session expired before this request could start.";
	if (!(error instanceof BillingApiError)) return null;

	const code = billingErrorDetail(error)?.code;
	if (code === "open_refund_debt") {
		return "Top up your Wallet before trying again.";
	}
	if (code === "deploy_request_funding_conflict") {
		return "This agent request is already linked to a different payment flow.";
	}
	if (code === "idempotency_key_reused") {
		return "This attempt could not be matched to the earlier request.";
	}
	if (error.detail === "payment_method_required") {
		return "Add a payment method before trying again.";
	}
	return null;
}

/**
 * Contextual, non-sensitive copy for the Deploy CTA. Card checkout has not
 * collected payment until its checkout UI opens, while wallet and create
 * transport failures can be ambiguous and must resume the same idempotent
 * attempt instead of claiming that nothing happened.
 */
export function deploySubmissionErrorPresentation(
	error: unknown,
	context: DeploySubmissionContext,
): DeploySubmissionErrorPresentation {
	const knownRecovery = knownBillingRecovery(error);
	if (context === "card_checkout") {
		const reason = isNetworkError(error)
			? error.kind === "timeout"
				? "The request timed out while opening secure checkout."
				: "The connection dropped while opening secure checkout."
			: isServerError(error)
				? "Secure checkout is temporarily unavailable."
				: (knownRecovery ?? "We couldn’t open secure checkout.");
		return {
			title: "Checkout didn’t open",
			description: `${reason} No payment was submitted. Retry when you’re ready.`,
		};
	}
	if (context === "subscription_assignment") {
		if (isDefinitiveBillingRejection(error)) {
			return {
				title: "Subscription assignment didn’t start",
				description: `${knownRecovery ?? "The request was rejected before it was accepted."} Review your choices and retry.`,
			};
		}
		const reason = isNetworkError(error)
			? error.kind === "timeout"
				? "The request timed out before subscription assignment and agent creation were confirmed."
				: "The connection dropped before subscription assignment and agent creation were confirmed."
			: "The service didn’t confirm subscription assignment and agent creation.";
		return {
			title: "We couldn’t confirm this attempt",
			description: `${reason} Retry to safely resume the same attempt.`,
		};
	}

	if (context === "wallet_creation") {
		if (isDefinitiveBillingRejection(error)) {
			return {
				title: "Payment and creation didn’t start",
				description: `${knownRecovery ?? "The request was rejected before it was accepted."} No Wallet payment was made. Review your choices and retry.`,
			};
		}
		const reason = isNetworkError(error)
			? error.kind === "timeout"
				? "The request timed out before payment and creation were confirmed."
				: "The connection dropped before payment and creation were confirmed."
			: "The service didn’t confirm payment and creation.";
		return {
			title: "We couldn’t confirm this attempt",
			description: `${reason} Retry to safely resume the same attempt.`,
		};
	}

	if (isDefinitiveBillingRejection(error)) {
		return {
			title: "Agent creation didn’t start",
			description: `${knownRecovery ?? "The request was rejected before it was accepted."} Your choices are unchanged; review them and retry.`,
		};
	}
	const reason = isNetworkError(error)
		? error.kind === "timeout"
			? "The request timed out before agent creation was confirmed."
			: "The connection dropped before agent creation was confirmed."
		: "The service didn’t confirm agent creation.";
	return {
		title: "We couldn’t confirm agent creation",
		description: `${reason} Retry to safely resume the same attempt.`,
	};
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

/**
 * Detect the managed-AI balance-exhausted condition. The deploy API emits this
 * as a structured 402 detail: `{"code": "insufficient_wallet_balance", ...}`
 * (see `_wallet_compute_insufficient_detail` in clawdi-hosted
 * `backend/app/v2/compute/routes.py`). Key on that code, never on free-form
 * message text from an upstream gateway.
 */
export const INSUFFICIENT_WALLET_BALANCE_CODE = "insufficient_wallet_balance";
export const FUNDING_AUTHORITY_INCONSISTENT_CODE = "funding_authority_inconsistent";

export function isInsufficientBalanceError(error: unknown): boolean {
	if (!(error instanceof BillingApiError)) return false;
	if (error.status !== 403 && error.status !== 402) return false;
	return billingErrorDetail(error)?.code === INSUFFICIENT_WALLET_BALANCE_CODE;
}

export function isPaymentMethodRequiredError(error: unknown): boolean {
	return (
		error instanceof BillingApiError &&
		(error.detail === "payment_method_required" ||
			billingErrorDetail(error)?.code === "payment_method_required")
	);
}

/**
 * Turn an API error into a single user-facing sentence. Hides backend
 * internals; normalizes balance exhaustion to the product narrative.
 */
export function normalizeBillingError(error: unknown): string {
	if (error instanceof DeploymentConflictError) return DEPLOYMENT_CONFLICT_MESSAGE;
	if (isInsufficientBalanceError(error)) {
		return "Your Wallet balance is too low. Top up or turn on auto-reload to keep Clawdi AI and hosted Agents running.";
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
		return "The billing request couldn’t be completed right now. Try again in a moment.";
	}
	if (error instanceof BillingApiError) {
		const code = billingErrorDetail(error)?.code;
		if (code === FUNDING_AUTHORITY_INCONSISTENT_CODE) {
			return "Billing for this subscription needs review. Contact support before making changes.";
		}
		if (code === "open_refund_debt") {
			return "Top up your Wallet to continue. New funds will first settle the outstanding balance.";
		}
		if (code === "deploy_request_funding_conflict") {
			return "This deployment is already linked to another payment.";
		}
		if (code === "idempotency_key_reused") {
			return "This request conflicts with an earlier submission. Review the details and try again.";
		}
		if (code === "checkout_attempt_expired") {
			return "This checkout has expired. Try again to open a new checkout.";
		}
		if (code === "checkout_payment_pending") {
			return "Your subscription is updating. Please check again shortly.";
		}
		if (code === "checkout_reconciliation_required") {
			return "We could not confirm your previous checkout. Contact support before starting another payment.";
		}
		if (code === "checkout_target_reserved") {
			return "A checkout is already open for this agent. Continue with the same subscription choice.";
		}
		if (typeof code === "string") {
			return "The billing request could not be completed. Refresh and try again.";
		}
		// A bare snake_case token is an internal error code, not product copy.
		if (/^[a-z0-9_]+$/.test(error.detail)) {
			if (error.detail === "payment_method_required") {
				return "Add a payment method and try again.";
			}
			return "The billing request could not be completed. Review the details and try again.";
		}
		return "The billing request could not be completed. Review the details and try again.";
	}
	if (error instanceof Error) {
		return "The billing request could not be completed. Try again.";
	}
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
