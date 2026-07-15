import type { HostedDeployment } from "@/hosted/billing/contracts";
import {
	computeSubscriptionId,
	computeTierLabel,
} from "@/hosted/billing/subscription/subscription-utils";

type ComputeSubscription = NonNullable<HostedDeployment["compute_subscription"]>;
type DunningDeployment = Pick<HostedDeployment, "compute_subscription" | "config_info">;
export type ComputePaymentState = ComputeSubscription["payment_state"];

export type ComputeDunningState = {
	paymentState: Exclude<ComputePaymentState, "ok">;
	fundingSource: "stripe" | "wallet";
	recoveryAction: "top_up" | "fix_payment";
	title: string;
	description: string;
	ctaTarget: "invoice" | "portal" | "wallet";
	invoiceUrl: string | null;
	subscriptionId: number | null;
	nextPaymentAttemptAt: string | null;
	serviceRiskAt: string | null;
	failureCode: string | null;
	tileLabel: string;
	tileTitle: string;
	tileTextClass: string;
};

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
	if (code === "open_refund_debt") return "A wallet refund is still settling.";
	return null;
}

export function computeDunningState(deployment: DunningDeployment): ComputeDunningState | null {
	const subscription = subscriptionForDunning(deployment);
	if (!subscription || subscription.payment_state === "ok") return null;
	const computeName = deployment.config_info
		? `${computeTierLabel(deployment.config_info.compute_plan_slug)} compute`
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
	};

	if (walletRecovery && subscription.payment_state === "past_due") {
		return {
			...common,
			paymentState: "past_due",
			title: "Wallet payment failed",
			description: `The latest ${computeName} debit failed. Your resources stay available during the 72-hour grace period; top up, then retry the payment.`,
			ctaTarget: "wallet",
			tileLabel: "Wallet payment past due",
			tileTitle: "Top up and retry before the compute grace period ends.",
			tileTextClass: "text-warning-muted-foreground",
		};
	}

	if (walletRecovery && subscription.payment_state === "unpaid") {
		return {
			...common,
			paymentState: "unpaid",
			title: "Wallet compute funding ended",
			description: `The grace period ended. The deployment fell back to included Basic when a slot was available; otherwise it stopped. Top up and retry to re-activate paid ${computeName}.`,
			ctaTarget: "wallet",
			tileLabel: "Wallet funding ended",
			tileTitle: "Paid compute fell back to included Basic or stopped after the grace period.",
			tileTextClass: "text-destructive",
		};
	}

	if (subscription.payment_state === "requires_action") {
		return {
			...common,
			paymentState: "requires_action",
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
