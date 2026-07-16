import type {
	ComputeFixPaymentRequest,
	ComputePlanSlug,
	HostedDeployment,
	HostedFundingEvent,
} from "@/hosted/billing/contracts";
import {
	computeSubscriptionId,
	computeTierLabel,
	pendingComputePlanSlug,
} from "@/hosted/billing/subscription/subscription-utils";

type ComputeSubscription = NonNullable<HostedDeployment["compute_subscription"]>;
type DunningDeployment = Pick<
	HostedDeployment,
	"compute_subscription" | "config_info" | "last_funding_event" | "status"
>;
export type ComputePaymentState = ComputeSubscription["payment_state"];

export type ComputeDunningState = {
	paymentState: Exclude<ComputePaymentState, "ok">;
	fundingSource: "stripe" | "wallet";
	recoveryAction: "top_up" | "fix_payment" | null;
	tone: "neutral" | "warning" | "destructive";
	title: string;
	description: string;
	ctaTarget:
		| "invoice"
		| "portal"
		| "wallet_retry"
		| "wallet_reactivate"
		| "billing_history"
		| "support"
		| "none";
	invoiceUrl: string | null;
	subscriptionId: number | null;
	nextPaymentAttemptAt: string | null;
	serviceRiskAt: string | null;
	failureCode: string | null;
	fallbackOccurredAt: string | null;
	fallbackPlanLabel: string | null;
	fallbackReason: HostedFundingEvent["reason"] | null;
	recoveryPlanSlug: ComputePlanSlug | null;
	tileLabel: string;
	tileTitle: string;
	tileTextClass: string;
};

export function fallbackReasonSentence(
	reason: HostedFundingEvent["reason"],
	planLabel: string,
	dateLabel: string,
): string {
	switch (reason) {
		case "payment_failure":
			return `This agent fell back from ${planLabel} because payment failed on ${dateLabel}.`;
		case "canceled":
			return `This agent fell back from ${planLabel} after you canceled the subscription on ${dateLabel}.`;
		case "refunded":
			return `This agent fell back from ${planLabel} after its payment was refunded on ${dateLabel}. Review Billing history for details.`;
		case "disputed":
			return `This agent fell back from ${planLabel} after its payment was disputed on ${dateLabel}. Review Billing history or contact support.`;
		case "admin_forced":
			return `This agent fell back from ${planLabel} after compute funding was changed by an administrator on ${dateLabel}. Contact support if this was unexpected.`;
	}
}

function subscriptionForDunning(deployment: DunningDeployment): ComputeSubscription | null {
	return deployment.compute_subscription ?? null;
}

export function dunningDeadlineCountdown(deadline: string | null, now = Date.now()): string | null {
	if (!deadline) return null;
	const deadlineMs = Date.parse(deadline);
	if (!Number.isFinite(deadlineMs)) return null;
	const remainingMs = deadlineMs - now;
	if (remainingMs <= 0) return "Grace period ended";
	const totalHours = Math.ceil(remainingMs / 3_600_000);
	const days = Math.floor(totalHours / 24);
	const hours = totalHours % 24;
	if (days === 0) return `${hours}h remaining`;
	return hours === 0 ? `${days}d remaining` : `${days}d ${hours}h remaining`;
}

export function collectionFailureMessage(code: string | null): string | null {
	if (code === "insufficient_balance") return "The wallet balance was too low.";
	if (code === "open_refund_debt") {
		return "New Wallet funds repay refund debt before compute charges.";
	}
	return null;
}

export function fixPaymentRequestForDunning(
	state: Pick<ComputeDunningState, "fallbackOccurredAt" | "fundingSource">,
	deploymentId: string,
): ComputeFixPaymentRequest {
	return state.fundingSource === "stripe" && state.fallbackOccurredAt
		? {}
		: { deployment_id: deploymentId };
}

export function computeDunningState(deployment: DunningDeployment): ComputeDunningState | null {
	const subscription = subscriptionForDunning(deployment);
	if (!subscription) {
		const fallback = deployment.last_funding_event;
		if (fallback?.type !== "compute_subscription_fallback") return null;
		const paymentFailure = fallback.reason === "payment_failure";
		const walletRecovery = paymentFailure && fallback.funding_source === "wallet";
		const fallbackPlanLabel =
			fallback.prior_plan_slug === "compute_performance"
				? "Performance compute"
				: fallback.prior_plan_slug === "compute_basic"
					? "Basic compute"
					: "paid compute";
		const stopped = deployment.status.toLowerCase() === "stopped";
		const recoveryPlanSlug: ComputePlanSlug | null =
			fallback.prior_plan_slug === "compute_performance"
				? "compute_performance"
				: fallback.prior_plan_slug === "compute_basic"
					? "compute_basic"
					: null;
		const fallbackPresentation = (() => {
			switch (fallback.reason) {
				case "payment_failure":
					return {
						tone: "destructive" as const,
						title: walletRecovery ? "Wallet compute funding ended" : "Compute funding ended",
						ctaTarget: walletRecovery ? ("wallet_reactivate" as const) : ("portal" as const),
						tileLabel: walletRecovery ? "Wallet funding ended" : "Compute funding ended",
						tileTextClass: "text-destructive",
					};
				case "canceled":
					return {
						tone: "neutral" as const,
						title: "Compute subscription ended",
						ctaTarget: "none" as const,
						tileLabel: "Compute subscription ended",
						tileTextClass: "text-muted-foreground",
					};
				case "refunded":
					return {
						tone: "neutral" as const,
						title: "Compute payment refunded",
						ctaTarget: "billing_history" as const,
						tileLabel: "Compute payment refunded",
						tileTextClass: "text-muted-foreground",
					};
				case "disputed":
					return {
						tone: "warning" as const,
						title: "Compute payment disputed",
						ctaTarget: "support" as const,
						tileLabel: "Compute payment disputed",
						tileTextClass: "text-warning-muted-foreground",
					};
				case "admin_forced":
					return {
						tone: "neutral" as const,
						title: "Compute funding changed",
						ctaTarget: "support" as const,
						tileLabel: "Compute funding changed",
						tileTextClass: "text-muted-foreground",
					};
			}
		})();
		return {
			...fallbackPresentation,
			paymentState: "unpaid",
			fundingSource: fallback.funding_source,
			recoveryAction: paymentFailure ? (walletRecovery ? "top_up" : "fix_payment") : null,
			description: stopped
				? paymentFailure
					? "The included Basic slot was occupied, so this agent stopped. Restore paid funding to start it again."
					: "The included Basic slot was occupied, so this agent stopped."
				: paymentFailure
					? "This agent is now using included Basic. Restore paid funding to re-activate its previous compute plan."
					: "This agent is now using included Basic.",
			invoiceUrl: null,
			subscriptionId: fallback.subscription_id,
			nextPaymentAttemptAt: null,
			serviceRiskAt: null,
			failureCode: null,
			fallbackOccurredAt: fallback.occurred_at,
			fallbackPlanLabel,
			fallbackReason: fallback.reason,
			recoveryPlanSlug,
			tileTitle: stopped
				? `${fallbackPlanLabel} stopped after its funding ended.`
				: `${fallbackPlanLabel} fell back to included Basic after its funding ended.`,
		};
	}
	if (subscription.payment_state === "ok") return null;
	const recoveryPlanSlug =
		pendingComputePlanSlug(subscription) ?? deployment.config_info?.compute_plan_slug ?? null;
	const computeName = recoveryPlanSlug
		? `${computeTierLabel(recoveryPlanSlug)} compute`
		: "paid compute";
	const fundingSource = subscription.funding_source ?? "stripe";
	const recoveryAction =
		subscription.recovery_action ?? (fundingSource === "wallet" ? "top_up" : "fix_payment");
	const walletRecovery = recoveryAction === "top_up";
	const invoiceUrl = subscription.latest_failed_invoice_hosted_url ?? null;
	const nextPaymentAttemptAt =
		subscription.next_collection_attempt_at ?? subscription.next_payment_attempt_at ?? null;
	const serviceRiskAt = walletRecovery
		? (subscription.dunning_deadline_at ?? subscription.current_period_end ?? null)
		: (nextPaymentAttemptAt ?? subscription.current_period_end ?? null);
	const common = {
		fundingSource,
		recoveryAction,
		invoiceUrl,
		subscriptionId: computeSubscriptionId(subscription),
		nextPaymentAttemptAt,
		serviceRiskAt,
		failureCode: subscription.last_collection_failure_code ?? null,
		fallbackOccurredAt: null,
		fallbackPlanLabel: null,
		fallbackReason: null,
		recoveryPlanSlug,
	};

	if (walletRecovery && subscription.payment_state === "past_due") {
		return {
			...common,
			paymentState: "past_due",
			tone: "warning",
			title: "Wallet payment failed",
			description: `The latest ${computeName} debit failed. Your resources stay available during the 72-hour grace period; top up, then retry the payment.`,
			ctaTarget: "wallet_retry",
			tileLabel: "Wallet payment past due",
			tileTitle: "Top up and retry before the compute grace period ends.",
			tileTextClass: "text-warning-muted-foreground",
		};
	}

	if (walletRecovery && subscription.payment_state === "unpaid") {
		return {
			...common,
			paymentState: "unpaid",
			tone: "destructive",
			title: "Wallet compute funding ended",
			description: `The grace period ended. The deployment fell back to included Basic when a slot was available; otherwise it stopped. Reactivate ${computeName} to start a new subscription.`,
			ctaTarget: "wallet_reactivate",
			tileLabel: "Wallet funding ended",
			tileTitle: "Paid compute fell back to included Basic or stopped after the grace period.",
			tileTextClass: "text-destructive",
		};
	}

	if (subscription.payment_state === "requires_action") {
		return {
			...common,
			paymentState: "requires_action",
			tone: "warning",
			title: "Payment authentication required",
			description: `Stripe needs bank authentication for the latest renewal invoice. Complete the payment to keep ${computeName} active.`,
			ctaTarget: invoiceUrl ? "invoice" : "portal",
			tileLabel: "Payment action required",
			tileTitle: `Complete payment authentication to keep ${computeName} active.`,
			tileTextClass: "text-warning-muted-foreground",
		};
	}

	if (subscription.payment_state === "past_due") {
		return {
			...common,
			paymentState: "past_due",
			tone: "warning",
			title: "Payment failed",
			description:
				"The latest renewal payment failed. Update your payment method before Stripe retries are exhausted.",
			ctaTarget: "portal",
			tileLabel: "Payment past due",
			tileTitle: "Update the payment method before retries are exhausted.",
			tileTextClass: "text-warning-muted-foreground",
		};
	}

	return {
		...common,
		paymentState: "unpaid",
		tone: "destructive",
		title: "Payment retries ended",
		description: `Stripe could not collect payment and ${computeName} entitlement was removed. Update your payment method before restoring this subscription.`,
		ctaTarget: "portal",
		tileLabel: "Payment unpaid",
		tileTitle: `${computeName} entitlement was removed after payment retries ended.`,
		tileTextClass: "text-destructive",
	};
}

export function computeDunningTileStatus(
	deployment: DunningDeployment,
): { label: string; title: string; textClass: string } | null {
	const state = computeDunningState(deployment);
	if (!state) return null;
	return {
		label: state.tileLabel,
		title: state.tileTitle,
		textClass: state.tileTextClass,
	};
}
