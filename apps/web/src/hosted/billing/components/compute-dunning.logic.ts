import type { HostedDeployment } from "@/hosted/billing/contracts";

type ComputeSubscription = NonNullable<HostedDeployment["compute_subscription"]>;
export type ComputePaymentState = ComputeSubscription["payment_state"];

export type ComputeDunningState = {
	paymentState: Exclude<ComputePaymentState, "ok">;
	title: string;
	description: string;
	ctaTarget: "invoice" | "portal";
	invoiceUrl: string | null;
	nextPaymentAttemptAt: string | null;
	serviceRiskAt: string | null;
	tileLabel: string;
	tileTitle: string;
	tileTextClass: string;
};

function subscriptionForDunning(
	deployment: Pick<HostedDeployment, "compute_subscription">,
): ComputeSubscription | null {
	return deployment.compute_subscription ?? null;
}

export function computeDunningState(
	deployment: Pick<HostedDeployment, "compute_subscription">,
): ComputeDunningState | null {
	const subscription = subscriptionForDunning(deployment);
	if (!subscription || subscription.payment_state === "ok") return null;

	const invoiceUrl = subscription.latest_failed_invoice_hosted_url ?? null;
	const nextPaymentAttemptAt = subscription.next_payment_attempt_at ?? null;
	const serviceRiskAt = nextPaymentAttemptAt ?? subscription.current_period_end ?? null;

	if (subscription.payment_state === "requires_action") {
		return {
			paymentState: "requires_action",
			title: "Payment authentication required",
			description:
				"Stripe needs bank authentication for the latest renewal invoice. Complete the payment to keep Performance compute active.",
			ctaTarget: invoiceUrl ? "invoice" : "portal",
			invoiceUrl,
			nextPaymentAttemptAt,
			serviceRiskAt,
			tileLabel: "Payment action required",
			tileTitle: "Complete payment authentication to keep Performance compute active.",
			tileTextClass: "text-warning-muted-foreground",
		};
	}

	if (subscription.payment_state === "past_due") {
		return {
			paymentState: "past_due",
			title: "Payment failed",
			description:
				"The latest renewal payment failed. Update your payment method before Stripe retries are exhausted.",
			ctaTarget: "portal",
			invoiceUrl,
			nextPaymentAttemptAt,
			serviceRiskAt,
			tileLabel: "Payment past due",
			tileTitle: "Update the payment method before retries are exhausted.",
			tileTextClass: "text-warning-muted-foreground",
		};
	}

	return {
		paymentState: "unpaid",
		title: "Payment retries ended",
		description:
			"Stripe could not collect payment and Performance entitlement was removed. Update your payment method before restoring this subscription.",
		ctaTarget: "portal",
		invoiceUrl,
		nextPaymentAttemptAt,
		serviceRiskAt,
		tileLabel: "Payment unpaid",
		tileTitle: "Performance entitlement was removed after payment retries ended.",
		tileTextClass: "text-destructive",
	};
}

export function computeDunningTileStatus(
	deployment: Pick<HostedDeployment, "compute_subscription">,
): { label: string; title: string; textClass: string } | null {
	const state = computeDunningState(deployment);
	if (!state) return null;
	return {
		label: state.tileLabel,
		title: state.tileTitle,
		textClass: state.tileTextClass,
	};
}
