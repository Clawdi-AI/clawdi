export type DeploySubmissionContext =
	| "card_checkout"
	| "included_creation"
	| "subscription_assignment"
	| "wallet_creation";

/**
 * A platform-neutral reading of a failed Deploy request. `rejected` is a definitive
 * 4xx other than 429; `server` is a 5xx or 429; `unknown` is anything else.
 */
export type DeploySubmissionFailure = {
	kind: "timeout" | "offline" | "server" | "rejected" | "unknown";
	/** Copy for a known public billing condition, from `deploySubmissionRecoveryCopy`. */
	recovery: string | null;
	/** Hosted's structured error code, when the response carried one. */
	code?: string | null;
};

/**
 * Hosted funded the subscription (a Wallet debit or an assignment) and then answered
 * 409 because the new deployment's acceptance is still pending; the lifecycle consumer
 * finishes it. Such a response must never read as "nothing happened".
 */
export const DEPLOY_ACCEPTANCE_PENDING_CODE = "deployment_acceptance_pending";

export type DeploySubmissionErrorPresentation = {
	description: string;
	title: string;
};

export const DEPLOY_SESSION_EXPIRED_RECOVERY =
	"Your session expired before this request could start.";

/** Only return copy backed by a known public billing condition. */
export function deploySubmissionRecoveryCopy({
	code,
	detail,
}: {
	code: unknown;
	detail?: string | null;
}): string | null {
	if (code === "open_refund_debt") return "Top up your wallet before trying again.";
	if (code === "deploy_request_funding_conflict") {
		return "This agent request is already linked to a different payment flow.";
	}
	if (code === "idempotency_key_reused") {
		return "This attempt couldn't be matched to the earlier request.";
	}
	if (detail === "payment_method_required") return "Add a payment method before trying again.";
	return null;
}

/**
 * Contextual, non-sensitive copy for the Deploy CTA. Card checkout has not
 * collected payment until its checkout UI opens, while wallet and create
 * transport failures can be ambiguous and must resume the same idempotent
 * attempt instead of claiming that nothing happened.
 */
export function deploySubmissionErrorCopy(
	{ kind, recovery, code }: DeploySubmissionFailure,
	context: DeploySubmissionContext,
): DeploySubmissionErrorPresentation {
	if (code === DEPLOY_ACCEPTANCE_PENDING_CODE && context === "wallet_creation") {
		return {
			title: "Your payment may have gone through",
			description:
				"We're still setting up this agent after your wallet payment. Check its status before retrying. Retrying resumes the same attempt and won't charge you twice.",
		};
	}
	if (code === DEPLOY_ACCEPTANCE_PENDING_CODE && context === "subscription_assignment") {
		return {
			title: "We're still setting up this agent",
			description:
				"The subscription may already be assigned. Check this agent's status before retrying. Retrying resumes the same attempt.",
		};
	}
	if (context === "card_checkout") {
		const reason =
			kind === "timeout"
				? "The request timed out while opening secure checkout."
				: kind === "offline"
					? "The connection dropped while opening secure checkout."
					: kind === "server"
						? "Secure checkout is temporarily unavailable."
						: (recovery ?? "We couldn’t open secure checkout.");
		return {
			title: "Checkout didn’t open",
			description: `${reason} No payment was submitted. Retry when you’re ready.`,
		};
	}
	if (context === "subscription_assignment") {
		if (kind === "rejected") {
			return {
				title: "Subscription assignment didn’t start",
				description: `${recovery ?? "The request was rejected."} Review your choices and retry.`,
			};
		}
		const reason =
			kind === "timeout"
				? "The request timed out before subscription assignment and agent creation were confirmed."
				: kind === "offline"
					? "The connection dropped before subscription assignment and agent creation were confirmed."
					: "The service didn’t confirm subscription assignment and agent creation.";
		return {
			title: "We couldn’t confirm this attempt",
			description: `${reason} Retry to safely resume the same attempt.`,
		};
	}

	if (context === "wallet_creation") {
		if (kind === "rejected") {
			return {
				title: "Payment and creation didn’t start",
				description: `${recovery ?? "The request was rejected."} No wallet payment was made. Review your choices and retry.`,
			};
		}
		const reason =
			kind === "timeout"
				? "The request timed out before payment and creation were confirmed."
				: kind === "offline"
					? "The connection dropped before payment and creation were confirmed."
					: "The service didn’t confirm payment and creation.";
		return {
			title: "We couldn’t confirm this attempt",
			description: `${reason} Retry to safely resume the same attempt.`,
		};
	}

	if (kind === "rejected") {
		return {
			title: "Agent creation didn’t start",
			description: `${recovery ?? "The request was rejected."} Your choices are unchanged. Review them and retry.`,
		};
	}
	const reason =
		kind === "timeout"
			? "The request timed out before agent creation was confirmed."
			: kind === "offline"
				? "The connection dropped before agent creation was confirmed."
				: "The service didn’t confirm agent creation.";
	return {
		title: "We couldn’t confirm agent creation",
		description: `${reason} Retry to safely resume the same attempt.`,
	};
}
