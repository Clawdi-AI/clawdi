import type {
	ComputePlanSlug,
	HostedDeployment,
	HostedFundingEvent,
} from "@/hosted/billing/contracts";
import {
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

function recoveryPlanSlugFor(
	deployment: DunningDeployment,
	subscription?: ComputeSubscription,
): ComputePlanSlug | null {
	if (subscription) {
		return (
			pendingComputePlanSlug(subscription) ?? deployment.config_info?.compute_plan_slug ?? null
		);
	}
	const priorPlan = deployment.last_funding_event?.prior_plan_slug;
	return priorPlan === "compute_basic" || priorPlan === "compute_performance" ? priorPlan : null;
}

function detachedFallbackState(deployment: DunningDeployment): ComputeDunningState | null {
	const fallback = deployment.last_funding_event;
	if (fallback?.type !== "compute_subscription_fallback") return null;

	const fallbackPlanLabel =
		fallback.prior_plan_slug === "compute_performance"
			? "Performance compute"
			: fallback.prior_plan_slug === "compute_basic"
				? "Basic compute"
				: "paid compute";
	const stopped = deployment.status.toLowerCase() === "stopped";
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
		recoveryPlanSlug: recoveryPlanSlugFor(deployment),
		ctaTarget: "start_new",
		tileTitle: stopped
			? `${fallbackPlanLabel} ended and the deployment stopped.`
			: `${fallbackPlanLabel} ended and fell back to included Basic.`,
	};
}

export function computeDunningState(deployment: DunningDeployment): ComputeDunningState | null {
	const subscription = deployment.compute_subscription ?? null;
	if (!subscription) return detachedFallbackState(deployment);
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
				"Top up AI Credits. Stripe will keep the invoice open while funds are short, and billing will update automatically after payment completes.",
			ctaTarget: "top_up",
			tileLabel: "Wallet payment past due",
			tileTitle: "Top up AI Credits to pay the open invoice.",
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
