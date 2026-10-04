import type { components } from "./deploy.generated";

type ComputeSubscriptionListItem = components["schemas"]["V2ComputeSubscriptionListItem"];
type HostedComputeSubscription = components["schemas"]["V2HostedComputeSubscriptionInfo"];
type StatusTone = "success" | "warning" | "destructive" | "info" | "neutral";

export const computeRecoveryCopy = {
	updating: "Updating subscription",
	processing: "Your request is still processing",
	unpaid: "Unpaid",
	actionRequired: "Payment action required",
	pastDue: "Past due",
	paymentProcessing: "Payment processing",
	attention: "Needs attention",
	awaitingPayment: "Waiting for payment confirmation",
	support: "Contact support to restore this subscription",
	ended: "Ended",
	paymentAttention: "Payment needs attention",
};
export type ComputeRecoveryCopy = typeof computeRecoveryCopy;

export type ComputeSubscriptionRecoveryFields =
	| (Pick<
			ComputeSubscriptionListItem,
			| "latest_failed_invoice_hosted_url"
			| "next_payment_attempt_at"
			| "payment_state"
			| "recovery_action"
			| "recovery_blocked_reason"
			| "actions"
	  > &
			Partial<Pick<ComputeSubscriptionListItem, "funding_source" | "status">>)
	| (Pick<
			HostedComputeSubscription,
			| "latest_failed_invoice_hosted_url"
			| "next_payment_attempt_at"
			| "payment_state"
			| "recovery_action"
			| "recovery_blocked_reason"
			| "actions"
	  > &
			Partial<Pick<HostedComputeSubscription, "funding_source" | "status">>);

export type ComputeRecoveryTarget =
	| { kind: "invoice"; action: "fix_payment"; url: string }
	| { kind: "fix_payment"; action: "fix_payment" }
	| { kind: "top_up"; action: "top_up" }
	| { kind: "start_new"; action: "start_new" };

export type ComputeSubscriptionRecoveryPresentation = {
	status: { label: string; tone: StatusTone };
	hasPaymentIssue: boolean;
	recoveryTarget: ComputeRecoveryTarget | null;
	schedule:
		| { verb: "Retries"; at: string; fallback: null }
		| { verb: null; at: null; fallback: string }
		| null;
};

export function computeSubscriptionRecoveryTarget(
	subscription: ComputeSubscriptionRecoveryFields,
): ComputeRecoveryTarget | null {
	if (subscription.actions?.command_state != null || subscription.recovery_blocked_reason != null)
		return null;
	const action = subscription.recovery_action;
	if (action === "top_up") return { kind: "top_up", action };
	if (action === "start_new") return { kind: "start_new", action };
	if (action === "fix_payment") {
		const invoiceUrl = subscription.latest_failed_invoice_hosted_url?.trim();
		return invoiceUrl
			? { kind: "invoice", action, url: invoiceUrl }
			: { kind: "fix_payment", action };
	}
	return null;
}

export function computeSubscriptionRecoveryPresentation(
	subscription: ComputeSubscriptionRecoveryFields | null | undefined,
	lifecycleStatus: ComputeSubscriptionRecoveryPresentation["status"],
	copy: ComputeRecoveryCopy = computeRecoveryCopy,
): ComputeSubscriptionRecoveryPresentation {
	if (!subscription) {
		return {
			status: lifecycleStatus,
			hasPaymentIssue: false,
			recoveryTarget: null,
			schedule: null,
		};
	}
	if (
		subscription.actions?.command_state != null ||
		(subscription.recovery_blocked_reason === "authority_pending" &&
			subscription.payment_state !== "unpaid")
	) {
		return {
			status: { label: copy.updating, tone: "warning" },
			hasPaymentIssue: false,
			recoveryTarget: null,
			schedule: { verb: null, at: null, fallback: copy.processing },
		};
	}

	const paymentStatus = (() => {
		switch (subscription.payment_state) {
			case "unpaid":
				return { label: copy.unpaid, tone: "destructive" } as const;
			case "requires_action":
				return { label: copy.actionRequired, tone: "warning" } as const;
			case "past_due":
				return { label: copy.pastDue, tone: "destructive" } as const;
			case "ok":
				return null;
			default:
				return null;
		}
	})();
	const target = computeSubscriptionRecoveryTarget(subscription);
	const terminal = target?.kind === "start_new";
	const blocked = subscription.recovery_blocked_reason;
	if (blocked) {
		return {
			status: {
				label: blocked === "payment_pending" ? copy.paymentProcessing : copy.attention,
				tone: "warning",
			},
			hasPaymentIssue: true,
			recoveryTarget: target,
			schedule: {
				verb: null,
				at: null,
				fallback: blocked === "payment_pending" ? copy.awaitingPayment : copy.support,
			},
		};
	}

	return {
		status: terminal ? { label: copy.ended, tone: "neutral" } : (paymentStatus ?? lifecycleStatus),
		hasPaymentIssue: paymentStatus !== null || target !== null,
		recoveryTarget: target,
		schedule:
			!terminal &&
			(subscription.payment_state === "past_due" ||
				subscription.payment_state === "requires_action")
				? subscription.next_payment_attempt_at
					? {
							verb: "Retries",
							at: subscription.next_payment_attempt_at,
							fallback: null,
						}
					: { verb: null, at: null, fallback: copy.paymentAttention }
				: null,
	};
}
