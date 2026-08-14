import type {
	ComputePlanSlug,
	HostedComputeSubscription,
	HostedDeployment,
	HostedFundingFact,
} from "@/hosted/billing/contracts";
import {
	type ComputeRecoveryTarget,
	computeSubscriptionRecoveryTarget,
} from "@/hosted/billing/subscription/compute-subscription-recovery";
import {
	computeTierLabel,
	isIncludedBasicSubscription,
	pendingComputePlanSlug,
} from "@/hosted/billing/subscription/subscription-utils";
import { deploymentStatusFromResource } from "@/hosted/deployment-status";

type DunningDeployment = Pick<
	HostedDeployment,
	"commercial_display" | "current_plan_slug" | "resource"
>;
export type ComputePaymentState = HostedComputeSubscription["payment_state"];
type FundingRevocationReason = NonNullable<HostedFundingFact["reason"]>;

export type ComputeDunningState = {
	paymentState: Exclude<ComputePaymentState, "ok">;
	fundingSource: "stripe" | "wallet";
	recoveryTarget: ComputeRecoveryTarget;
	tone: "neutral" | "warning" | "destructive";
	title: string;
	description: string;
	secondaryTarget: "transactions" | "support" | null;
	fallbackOccurredAt: string | null;
	fallbackPlanLabel: string | null;
	fallbackReason: FundingRevocationReason | null;
	recoveryPlanSlug: ComputePlanSlug | null;
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
			return `This agent fell back from ${planLabel} after its payment was refunded on ${dateLabel}. Review Transactions for details.`;
		case "disputed":
			return `This agent fell back from ${planLabel} after its payment was disputed on ${dateLabel}. Review Transactions or contact support.`;
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
	const deploymentStatus = deploymentStatusFromResource(deployment.resource.status);
	const stopped = deploymentStatus.kind === "stopped";
	const statusUnavailable = !deploymentStatus.known;
	const presentation = (() => {
		switch (fallback.reason) {
			case "payment_failure":
				return {
					tone: "destructive" as const,
					title: "Compute subscription ended",
					secondaryTarget: null,
				};
			case "canceled":
				return {
					tone: "neutral" as const,
					title: "Compute subscription ended",
					secondaryTarget: null,
				};
			case "refunded":
				return {
					tone: "neutral" as const,
					title: "Compute payment refunded",
					secondaryTarget: "transactions" as const,
				};
			case "disputed":
				return {
					tone: "warning" as const,
					title: "Compute payment disputed",
					secondaryTarget: "support" as const,
				};
			case "admin_forced":
				return {
					tone: "neutral" as const,
					title: "Compute funding changed",
					secondaryTarget: "support" as const,
				};
		}
	})();

	return {
		...presentation,
		paymentState: "unpaid",
		fundingSource: fallback.funding_source,
		recoveryTarget: { kind: "start_new", action: "start_new" },
		description: statusUnavailable
			? "We can’t determine whether this agent stopped or is using free compute because its current status is unavailable. Start a new subscription to restore paid compute."
			: stopped
				? "No free compute slot was available, so this agent stopped. Start a new subscription to restore paid compute."
				: "This agent is now using free compute. Start a new subscription to restore paid compute.",
		fallbackOccurredAt: fallback.occurred_at,
		fallbackPlanLabel,
		fallbackReason: fallback.reason,
		recoveryPlanSlug,
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
	const recoveryTarget = computeSubscriptionRecoveryTarget(subscription);
	if (!recoveryTarget) return null;

	const recoveryPlanSlug = recoveryPlanSlugFor(deployment, subscription);
	const computeName = recoveryPlanSlug
		? `${computeTierLabel(recoveryPlanSlug)} compute`
		: "paid compute";
	const fundingSource = subscription.funding_source ?? "stripe";
	const common = {
		fundingSource,
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
			recoveryTarget,
			tone: "destructive",
			title: "Compute subscription ended",
			description:
				"This paid subscription ended. Start a new subscription for this agent to restore paid compute.",
		};
	}

	if (subscription.payment_state === "requires_action") {
		return {
			...common,
			paymentState: "requires_action",
			recoveryTarget,
			tone: "warning",
			title: "Payment authentication required",
			description: `Complete the payment authentication to keep ${computeName} active.`,
		};
	}

	if (fundingSource === "wallet") {
		return {
			...common,
			paymentState: "past_due",
			recoveryTarget,
			tone: "warning",
			title: "Wallet payment past due",
			description:
				"Top up your Wallet. Stripe will keep the invoice open while funds are short, and billing will update automatically after payment completes.",
		};
	}

	return {
		...common,
		paymentState: "past_due",
		recoveryTarget,
		tone: "warning",
		title: "Payment past due",
		description: "Update the card payment method for the open invoice.",
	};
}
