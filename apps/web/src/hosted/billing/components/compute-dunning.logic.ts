import type {
	ComputePlanSlug,
	HostedComputeSubscription,
	HostedDeployment,
} from "@/hosted/billing/contracts";
import {
	computeTierLabel,
	pendingComputePlanSlug,
} from "@/hosted/billing/subscription/subscription-utils";

type DunningDeployment = Pick<HostedDeployment, "commercial_display" | "resource">;
export type ComputePaymentState = HostedComputeSubscription["payment_state"];

export type ComputeDunningState = {
	paymentState: Exclude<ComputePaymentState, "ok">;
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
	recoveryPlanSlug: ComputePlanSlug | null;
	tileLabel: string;
	tileTitle: string;
	tileTextClass: string;
};

function recoveryPlanSlugFor(
	deployment: DunningDeployment,
	subscription?: HostedComputeSubscription,
): ComputePlanSlug | null {
	const planSlug =
		pendingComputePlanSlug(subscription) ??
		deployment.commercial_display?.latest_funding_fact?.compute_plan_slug;
	return planSlug === "compute_basic" || planSlug === "compute_performance" ? planSlug : null;
}

function detachedFallbackState(deployment: DunningDeployment): ComputeDunningState | null {
	const fallback = deployment.commercial_display?.latest_funding_fact;
	if (fallback?.fact_kind !== "funding_revoked") return null;

	const fallbackPlanLabel = "Paid compute";
	const stopped = deployment.resource.status.summary_state === "stopped";

	return {
		paymentState: "unpaid",
		recoveryAction: "start_new",
		tone: "destructive",
		title: "Compute funding ended",
		description: stopped
			? "No included Basic slot was available, so this deployment stopped. Start a new subscription to restore paid compute."
			: "This deployment is now using included Basic. Start a new subscription to restore paid compute.",
		invoiceUrl: null,
		secondaryTarget: "billing_history",
		fallbackOccurredAt: fallback.emitted_at,
		fallbackPlanLabel,
		recoveryPlanSlug: null,
		ctaTarget: "start_new",
		tileLabel: "Compute funding ended",
		tileTitle: stopped
			? `${fallbackPlanLabel} ended and the deployment stopped.`
			: `${fallbackPlanLabel} ended and fell back to included Basic.`,
		tileTextClass: "text-destructive",
	};
}

export function computeDunningState(deployment: DunningDeployment): ComputeDunningState | null {
	const subscription = deployment.commercial_display?.compute_subscription ?? null;
	const fallbackState = detachedFallbackState(deployment);
	if (fallbackState) return fallbackState;
	if (!subscription) return null;
	if (subscription.payment_state === "ok") return null;

	const recoveryPlanSlug = recoveryPlanSlugFor(deployment, subscription);
	const computeName = recoveryPlanSlug
		? `${computeTierLabel(recoveryPlanSlug)} compute`
		: "paid compute";
	const fundingSource = subscription.funding_source ?? "stripe";
	const common = {
		invoiceUrl: subscription.latest_failed_invoice_hosted_url ?? null,
		fallbackOccurredAt: null,
		fallbackPlanLabel: null,
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
