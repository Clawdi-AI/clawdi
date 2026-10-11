import { API_ERROR_COPY, type RequestFailure } from "./api-error-copy";

/**
 * The managed-AI balance-exhausted condition: hosted answers 402 (or 403) with this
 * structured code. Key on the code, never on free-form upstream gateway text.
 */
export const INSUFFICIENT_WALLET_BALANCE_CODE = "insufficient_wallet_balance";

/** Copy for hosted billing error codes that have a known public recovery. */
export const BILLING_ERROR_CODE_COPY: Readonly<Record<string, string>> = {
	funding_authority_inconsistent:
		"Billing for this subscription needs review. Contact support before making changes.",
	open_refund_debt:
		"Top up your wallet to continue. New funds will first settle the outstanding balance.",
	deploy_request_funding_conflict: "This agent is already linked to another payment.",
	idempotency_key_reused:
		"This request conflicts with an earlier submission. Review the details and try again.",
	checkout_attempt_expired: "This checkout has expired. Try again to open a new checkout.",
	checkout_payment_pending: "Your subscription is updating. Check again shortly.",
	checkout_reconciliation_required:
		"We couldn't confirm your previous checkout. Contact support before starting another payment.",
	checkout_target_reserved:
		"A checkout is already open for this agent. Continue with the same subscription choice.",
};

/**
 * One user-facing sentence for a failed billing request. Hides backend internals and
 * reads balance exhaustion as the top-up narrative, never a raw gateway error.
 */
export function billingErrorCopy(failure: RequestFailure): string {
	if (failure.kind === "timeout") return API_ERROR_COPY.timeout;
	if (failure.kind === "offline") {
		return "We couldn't reach the billing service. Check your connection and try again.";
	}
	if (failure.kind !== "response") {
		return failure.kind === "error"
			? "The billing request couldn't be completed. Try again."
			: API_ERROR_COPY.genericError;
	}
	const { status, code, detail } = failure;
	if ((status === 402 || status === 403) && code === INSUFFICIENT_WALLET_BALANCE_CODE) {
		return "Your wallet balance is too low. Top up or turn on auto-reload to keep Clawdi AI and Cloud Agents running.";
	}
	if (status === 401) return API_ERROR_COPY.expired;
	if (status >= 500 || status === 429) {
		return "The billing request couldn’t be completed right now. Try again in a moment.";
	}
	if (typeof code === "string") {
		return Object.hasOwn(BILLING_ERROR_CODE_COPY, code)
			? BILLING_ERROR_CODE_COPY[code]
			: "The billing request couldn't be completed. Refresh and try again.";
	}
	if (detail === "payment_method_required") return "Add a payment method and try again.";
	return "The billing request couldn't be completed. Review the details and try again.";
}
