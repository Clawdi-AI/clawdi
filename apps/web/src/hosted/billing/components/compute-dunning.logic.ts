import type {
	ComputePlanSlug,
	HostedComputeSubscription,
	HostedDeployment,
	HostedFundingFact,
} from "@/hosted/billing/contracts";
import {
	computeTierLabel,
	isIncludedBasicSubscription,
	pendingComputePlanSlug,
} from "@/hosted/billing/subscription/subscription-utils";

type DunningDeployment = Pick<
	HostedDeployment,
	"commercial_display" | "current_plan_slug" | "resource"
>;
export type ComputePaymentState = HostedComputeSubscription["payment_state"];
type FundingRevocationReason = NonNullable<HostedFundingFact["reason"]>;

export type ComputeDunningState = {
	paymentState: Exclude<ComputePaymentState, "ok">;
	fundingSource: "stripe" | "wallet";
	recoveryAction: "top_up" | "fix_payment" | "start_new" | null;
	tone: "neutral" | "warning" | "destructive";
	title: string;
	description: string;
	ctaTarget:
		| "invoice"
		| "fix_payment"
		| "top_up"
		| "start_new"
		| "billing_history"
		| "support"
		| "none";
	invoiceUrl: string | null;
	secondaryTarget: "billing_history" | "support" | null;
	fallbackOccurredAt: string | null;
	fallbackPlanLabel: string | null;
	fallbackReason: FundingRevocationReason | null;
	recoveryPlanSlug: ComputePlanSlug | null;
	tileLabel: string;
	tileTitle: string;
	tileTextClass: string;
};

export function fallbackReasonSentence(
	reason: FundingRevocationReason,
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

function recoveryPlanSlugFor(
	deployment: DunningDeployment,
	subscription?: HostedComputeSubscription,
): ComputePlanSlug | null {
	const planSlug = subscription
		? (pendingComputePlanSlug(subscription) ?? deployment.current_plan_slug)
		: deployment.commercial_display?.latest_funding_fact?.prior_plan_slug;
	return planSlug === "compute_basic" || planSlug === "compute_performance" ? planSlug : null;
}

function detachedFallbackState(deployment: DunningDeployment): ComputeDunningState | null {
	const fallback = deployment.commercial_display?.latest_funding_fact;
	if (fallback?.fact_kind !== "funding_revoked") return null;
	if (!fallback.reason || !fallback.funding_source) return null;
	const recoveryPlanSlug = recoveryPlanSlugFor(deployment);
	if (!recoveryPlanSlug) return null;

	const fallbackPlanLabel = `${computeTierLabel(recoveryPlanSlug)} compute`;
	const stopped = deployment.resource.status.summary_state === "stopped";
	const presentation = (() => {
		switch (fallback.reason) {
			case "payment_failure":
				return {
					tone: "destructive" as const,
					title: "Compute subscription ended",
					secondaryTarget: null,
					tileLabel: "Compute subscription ended",
					tileTextClass: "text-destructive",
				};
			case "canceled":
				return {
					tone: "neutral" as const,
					title: "Compute subscription ended",
					secondaryTarget: null,
					tileLabel: "Compute subscription ended",
					tileTextClass: "text-muted-foreground",
				};
			case "refunded":
				return {
					tone: "neutral" as const,
					title: "Compute payment refunded",
					secondaryTarget: "billing_history" as const,
					tileLabel: "Compute payment refunded",
					tileTextClass: "text-muted-foreground",
				};
			case "disputed":
				return {
					tone: "warning" as const,
					title: "Compute payment disputed",
					secondaryTarget: "support" as const,
					tileLabel: "Compute payment disputed",
					tileTextClass: "text-warning-muted-foreground",
				};
			case "admin_forced":
				return {
					tone: "neutral" as const,
					title: "Compute funding changed",
					secondaryTarget: "support" as const,
					tileLabel: "Compute funding changed",
					tileTextClass: "text-muted-foreground",
				};
		}
	})();

	return {
		...presentation,
		paymentState: "unpaid",
		fundingSource: fallback.funding_source,
		recoveryAction: "start_new",
		description: stopped
			? "No included Basic slot was available, so this deployment stopped. Start a new subscription to restore paid compute."
			: "This deployment is now using included Basic. Start a new subscription to restore paid compute.",
		invoiceUrl: null,
		fallbackOccurredAt: fallback.occurred_at,
		fallbackPlanLabel,
		fallbackReason: fallback.reason,
		recoveryPlanSlug,
		ctaTarget: "start_new",
		tileTitle: stopped
			? `${fallbackPlanLabel} ended and the deployment stopped.`
			: `${fallbackPlanLabel} ended and fell back to included Basic.`,
	};
}

export function computeDunningState(deployment: DunningDeployment): ComputeDunningState | null {
	const subscription = deployment.commercial_display?.compute_subscription ?? null;
	const fallbackState = detachedFallbackState(deployment);
	if (fallbackState && isIncludedBasicSubscription(deployment.current_plan_slug, subscription)) {
		return fallbackState;
	}
	if (!subscription) return null;
	if (subscription.payment_state === "ok") return null;

	const recoveryPlanSlug = recoveryPlanSlugFor(deployment, subscription);
	const computeName = recoveryPlanSlug
		? `${computeTierLabel(recoveryPlanSlug)} compute`
		: "paid compute";
	const fundingSource = subscription.funding_source ?? "stripe";
	const common = {
		fundingSource,
		invoiceUrl: subscription.latest_failed_invoice_hosted_url ?? null,
		fallbackOccurredAt: null,
		fallbackPlanLabel: null,
		fallbackReason: null,
		recoveryPlanSlug,
		secondaryTarget: null,
	};

	if (subscription.payment_state === "unpaid") {
		return {
			...common,
			paymentState: "unpaid",
			recoveryAction: "start_new",
			tone: "destructive",
			title: "Compute subscription ended",
			description:
				"This paid subscription is terminal. Start a new subscription for the fallback deployment to restore paid compute.",
			ctaTarget: "start_new",
			tileLabel: "Compute subscription ended",
			tileTitle: `${computeName} ended. Start a new subscription to restore paid compute.`,
			tileTextClass: "text-destructive",
		};
	}

	if (subscription.payment_state === "requires_action") {
		return {
			...common,
			paymentState: "requires_action",
			recoveryAction: "fix_payment",
			tone: "warning",
			title: "Payment authentication required",
			description: `Complete the payment authentication to keep ${computeName} active.`,
			ctaTarget: common.invoiceUrl ? "invoice" : "fix_payment",
			tileLabel: "Payment action required",
			tileTitle: `Complete payment authentication to keep ${computeName} active.`,
			tileTextClass: "text-warning-muted-foreground",
		};
	}

	if (fundingSource === "wallet") {
		return {
			...common,
			paymentState: "past_due",
			recoveryAction: "top_up",
			tone: "warning",
			title: "Wallet payment past due",
			description:
				"Top up your Wallet. Stripe will keep the invoice open while funds are short, and billing will update automatically after payment completes.",
			ctaTarget: "top_up",
			tileLabel: "Wallet payment past due",
			tileTitle: "Top up your Wallet to pay the open invoice.",
			tileTextClass: "text-warning-muted-foreground",
		};
	}

	return {
		...common,
		paymentState: "past_due",
		recoveryAction: "fix_payment",
		tone: "warning",
		title: "Payment past due",
		description: "Update the card payment method for the open invoice.",
		ctaTarget: "fix_payment",
		tileLabel: "Payment past due",
		tileTitle: "Fix the card payment method for the open invoice.",
		tileTextClass: "text-warning-muted-foreground",
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
