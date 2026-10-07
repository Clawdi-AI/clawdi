import type { DeployComponents, DeploymentRead } from "../api";
import { formatShortDate } from "./format";

type HostedDeployment = DeploymentRead;
type HostedComputeSubscription = NonNullable<
	NonNullable<DeploymentRead["commercial_display"]>["compute_subscription"]
>;
type ComputePlanSlug = DeployComponents["schemas"]["V2HostedDeployRequest"]["compute_plan_slug"];
type HostedFundingFact = DeployComponents["schemas"]["V2HostedCommercialFundingFactInfo"];

import {
	type ComputeRecoveryTarget,
	computeSubscriptionRecoveryTarget,
} from "../api/compute-recovery";
import {
	computeTierLabel,
	isIncludedBasicSubscription,
	pendingComputePlanSlug,
} from "./compute-subscriptions";
import { deploymentStatusFromResource } from "./deployment-status";

type DunningDeployment = Pick<
	HostedDeployment,
	"commercial_display" | "current_plan_slug" | "resource"
>;
export type ComputePaymentState = HostedComputeSubscription["payment_state"];
type FundingRevocationReason = NonNullable<HostedFundingFact["reason"]>;

export type ComputeDunningState = {
	paymentState: Exclude<ComputePaymentState, "ok">;
	fundingSource: "stripe" | "wallet";
	recoveryTarget: ComputeRecoveryTarget | null;
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
			return `This agent fell back from the ${planLabel} because payment failed on ${dateLabel}.`;
		case "canceled":
			return `This agent fell back from the ${planLabel} after you canceled the subscription on ${dateLabel}.`;
		case "refunded":
			return `This agent fell back from the ${planLabel} after its payment was refunded on ${dateLabel}. Review Transactions for details.`;
		case "disputed":
			return `This agent fell back from the ${planLabel} after its payment was disputed on ${dateLabel}. Review Transactions or contact support.`;
		case "admin_forced":
			return `This agent fell back from the ${planLabel} after an administrator changed its funding on ${dateLabel}. Contact support if this was unexpected.`;
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
	if (deployment.commercial_display?.recovery_action !== "start_new") return null;
	if (fallback?.fact_kind !== "funding_revoked") return null;
	if (!fallback.reason || !fallback.funding_source || fallback.funding_source === "store")
		return null;
	const recoveryPlanSlug = recoveryPlanSlugFor(deployment);
	if (!recoveryPlanSlug) return null;

	const fallbackPlanLabel = `${computeTierLabel(recoveryPlanSlug)} plan`;
	const deploymentStatus = deploymentStatusFromResource(deployment.resource.status);
	const stopped = deploymentStatus.kind === "stopped";
	const statusUnavailable = !deploymentStatus.known;
	const includedBasic = isIncludedBasicSubscription(
		deployment.current_plan_slug,
		deployment.commercial_display?.compute_subscription,
	);
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
			? "The agent’s current status is unavailable. Check again in a moment. Your saved data is kept."
			: stopped
				? includedBasic
					? "This agent is stopped. You can start it on included Basic or choose a paid subscription. Your saved data is kept."
					: "This agent is stopped. Choose a subscription to start it. Your saved data is kept."
				: includedBasic
					? "This agent is now using included Basic. Start a new subscription to restore paid compute."
					: "This subscription ended. Choose a subscription to use this agent again. Your saved data is kept.",
		fallbackOccurredAt: fallback.occurred_at,
		fallbackPlanLabel,
		fallbackReason: fallback.reason,
		recoveryPlanSlug,
	};
}

export function computeDunningState(deployment: DunningDeployment): ComputeDunningState | null {
	const subscription = deployment.commercial_display?.compute_subscription ?? null;
	const fallbackState = detachedFallbackState(deployment);
	if (
		fallbackState &&
		(!subscription || isIncludedBasicSubscription(deployment.current_plan_slug, subscription))
	) {
		return fallbackState;
	}
	if (!subscription) return null;
	const fundingSource = subscription.funding_source;
	if (fundingSource !== "stripe" && fundingSource !== "wallet") return null;
	const recoveryTarget = computeSubscriptionRecoveryTarget(subscription);

	const recoveryPlanSlug = recoveryPlanSlugFor(deployment, subscription);
	const computeName = recoveryPlanSlug
		? `your ${computeTierLabel(recoveryPlanSlug)} plan`
		: "your paid plan";
	const common = {
		fundingSource,
		fallbackOccurredAt: null,
		fallbackPlanLabel: null,
		fallbackReason: null,
		recoveryPlanSlug,
		secondaryTarget: null,
	};
	if (
		fundingSource === "wallet" &&
		subscription.recovery_blocked_reason === "reconciliation_required" &&
		subscription.actions?.command_state == null &&
		subscription.payment_state !== "ok"
	) {
		return {
			...common,
			paymentState: subscription.payment_state,
			recoveryTarget: null,
			secondaryTarget: "support",
			tone: "warning",
			title: "Wallet payment needs review",
			description:
				"This invoice needs billing review before payment can continue. Contact support; adding funds will not resolve this billing state.",
		};
	}
	if (!recoveryTarget) return null;

	if (recoveryTarget.kind === "start_new") {
		return {
			...common,
			paymentState: "unpaid",
			recoveryTarget,
			tone: "destructive",
			title: "Compute subscription ended",
			description:
				"This subscription is no longer active. Choose a subscription to start this agent. Your saved data is kept.",
		};
	}
	if (subscription.payment_state === "ok") return null;

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
				"Top up your wallet. Stripe will keep the invoice open while funds are short, and billing will update automatically after payment completes.",
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

export function computeSubscriptionRequiredToStart(
	deployment: Pick<HostedDeployment, "start_action">,
): boolean {
	return deployment.start_action === "subscribe";
}

export const computeDunningCopy = {
	startUnavailable:
		"Starting a new subscription is temporarily unavailable. This agent remains visible and manageable.",
	startNew: "Start a new subscription",
	transactions: "View transactions",
	support: "Contact support",
} as const;

export function computeDunningDescription(state: ComputeDunningState): string {
	return [
		state.fallbackOccurredAt && state.fallbackPlanLabel && state.fallbackReason
			? fallbackReasonSentence(
					state.fallbackReason,
					state.fallbackPlanLabel,
					formatShortDate(state.fallbackOccurredAt),
				)
			: null,
		state.description,
	]
		.filter(Boolean)
		.join(" ");
}

/**
 * A detached Agent whose store funding ended may start card or Wallet funding when the
 * server offers `start_new`. Store endings have no dunning banner, so only the target is
 * exposed here.
 */
export function detachedStoreRecoveryTarget(
	deployment: Pick<HostedDeployment, "commercial_display">,
): ComputeRecoveryTarget | null {
	const display = deployment.commercial_display;
	if (display?.recovery_action !== "start_new" || display.compute_subscription) return null;
	const fact = display.latest_funding_fact;
	return fact?.fact_kind === "funding_revoked" && fact.funding_source === "store"
		? { kind: "start_new", action: "start_new" }
		: null;
}
