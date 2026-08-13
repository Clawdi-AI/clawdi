import type { StatusTone } from "@/components/ui/status-badge";
import type {
	ComputeSubscriptionListItem,
	HostedComputeSubscription,
} from "@/hosted/billing/contracts";

type RecoveryFields =
	| Pick<
			ComputeSubscriptionListItem,
			| "latest_failed_invoice_hosted_url"
			| "next_payment_attempt_at"
			| "payment_state"
			| "recovery_action"
	  >
	| Pick<
			HostedComputeSubscription,
			| "latest_failed_invoice_hosted_url"
			| "next_payment_attempt_at"
			| "payment_state"
			| "recovery_action"
	  >;

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
		| { verb: null; at: null; fallback: "Payment needs attention" }
		| null;
};

function recoveryTarget(subscription: RecoveryFields): ComputeRecoveryTarget | null {
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
	subscription: RecoveryFields | null | undefined,
	lifecycleStatus: ComputeSubscriptionRecoveryPresentation["status"],
): ComputeSubscriptionRecoveryPresentation {
	if (!subscription) {
		return {
			status: lifecycleStatus,
			hasPaymentIssue: false,
			recoveryTarget: null,
			schedule: null,
		};
	}

	const paymentStatus = (() => {
		switch (subscription.payment_state) {
			case "unpaid":
				return { label: "Unpaid", tone: "destructive" } as const;
			case "requires_action":
				return { label: "Payment action required", tone: "warning" } as const;
			case "past_due":
				return { label: "Past due", tone: "destructive" } as const;
			case "ok":
				return null;
			default:
				return null;
		}
	})();
	const target = recoveryTarget(subscription);

	return {
		status: paymentStatus ?? lifecycleStatus,
		hasPaymentIssue: paymentStatus !== null || target !== null,
		recoveryTarget: target,
		schedule:
			subscription.payment_state === "past_due" || subscription.payment_state === "requires_action"
				? subscription.next_payment_attempt_at
					? {
							verb: "Retries",
							at: subscription.next_payment_attempt_at,
							fallback: null,
						}
					: { verb: null, at: null, fallback: "Payment needs attention" }
				: null,
	};
}
