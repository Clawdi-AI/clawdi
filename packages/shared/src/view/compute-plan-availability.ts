import type { DeployComponents, DeploymentRead } from "../api";

type HostedDeployment = DeploymentRead;
type ComputePlanSlug = DeployComponents["schemas"]["V2HostedDeployRequest"]["compute_plan_slug"];

import { COMPUTE_PERFORMANCE_SLUG } from "./compute-subscriptions";

type HostedComputeUpgradeIneligibilityReason = NonNullable<
	HostedDeployment["upgrade_eligibility"]["reason"]
>;

const PERFORMANCE_UPGRADE_UNAVAILABLE_COPY = {
	deployment_deleted:
		"This agent has been deleted, so it can’t be upgraded. Create a new agent if you need Performance.",
	compute_basic_required:
		"Only agents on the Basic plan can be upgraded to Performance. No upgrade is available for this agent’s current plan.",
	compute_subscription_unavailable:
		"Clawdi couldn’t read this agent’s subscription details, so it can’t safely start an upgrade. Check again in a moment.",
	included_basic_required:
		"This agent’s subscription is managed separately, so it can’t be upgraded here. Use the subscription controls to change its plan instead.",
	compute_subscription_not_active:
		"Clawdi can’t start this upgrade because this agent’s no-cost subscription is not active. You were not charged, and there’s nothing you need to fix. Check again later.",
	compute_subscription_canceling:
		"This agent’s subscription is set to cancel, so it can’t be upgraded. Resume the subscription first, then try again.",
	deployment_state_unknown:
		"Clawdi couldn’t read this agent’s current state. Check again before trying to upgrade.",
	deployment_must_be_running_or_stopped:
		"Wait until this agent is running or stopped before trying to upgrade again.",
	upgrade_already_in_progress:
		"An upgrade to Performance is already in progress. Wait for it to finish; there is no second upgrade to start.",
} satisfies Record<HostedComputeUpgradeIneligibilityReason, string>;

const UNKNOWN_PERFORMANCE_UPGRADE_UNAVAILABLE_COPY =
	"Clawdi can’t confirm why this agent can’t be upgraded right now. Check again later, or contact support if this continues.";

function performanceUpgradeEligibilityReasonCopy(reason: string | null): string {
	return reason !== null && isHostedComputeUpgradeIneligibilityReason(reason)
		? PERFORMANCE_UPGRADE_UNAVAILABLE_COPY[reason]
		: UNKNOWN_PERFORMANCE_UPGRADE_UNAVAILABLE_COPY;
}

function isHostedComputeUpgradeIneligibilityReason(
	reason: string,
): reason is HostedComputeUpgradeIneligibilityReason {
	return Object.hasOwn(PERFORMANCE_UPGRADE_UNAVAILABLE_COPY, reason);
}

export function planChangeUnavailableReason({
	canCreateCloudAgents,
	cancelAtPeriodEnd,
	status,
	hasSubscriptionTarget,
}: {
	canCreateCloudAgents: boolean;
	cancelAtPeriodEnd: boolean;
	status: string;
	hasSubscriptionTarget: boolean;
}): string | null {
	if (!canCreateCloudAgents) return "Subscription changes are temporarily unavailable.";
	if (cancelAtPeriodEnd)
		return "Resume this subscription before changing its plan, billing term, or payment source.";
	if (!hasSubscriptionTarget)
		return "Subscription changes will be available after details finish syncing.";
	if (status !== "active" && status !== "past_due") {
		return "Resolve the subscription status before changing its plan, billing term, or payment source.";
	}
	return null;
}

export function performanceUpgradeUnavailableReason({
	plansLoading,
	canCreateCloudAgents,
	isIncludedBasic,
	performancePlanAvailable,
	pendingPlanSlug,
	planChangeUnavailable,
	deploymentStatusSupportsUpgrade,
	upgradeAvailable,
	upgradeEligibilityReason,
}: {
	plansLoading: boolean;
	canCreateCloudAgents: boolean;
	isIncludedBasic: boolean;
	performancePlanAvailable: boolean;
	pendingPlanSlug: ComputePlanSlug | null;
	planChangeUnavailable: string | null;
	deploymentStatusSupportsUpgrade: boolean;
	upgradeAvailable: boolean;
	upgradeEligibilityReason: string | null;
}): string | null {
	if (plansLoading) return "Checking Performance availability…";
	if (!canCreateCloudAgents) return "Upgrades are temporarily unavailable.";
	if (!performancePlanAvailable)
		return "The Performance plan is unavailable right now. Try again later.";
	if (!upgradeAvailable) {
		return performanceUpgradeEligibilityReasonCopy(upgradeEligibilityReason);
	}
	if (!isIncludedBasic) {
		return "This upgrade is only available for Basic agents without a separate subscription. Use this agent’s subscription controls to change its plan.";
	}
	if (pendingPlanSlug === COMPUTE_PERFORMANCE_SLUG) {
		return "An upgrade to Performance is already scheduled.";
	}
	if (planChangeUnavailable) return planChangeUnavailable;
	if (!deploymentStatusSupportsUpgrade) {
		return "Wait until this Basic agent is running or stopped before trying to upgrade again.";
	}
	return null;
}

export type PlanChangeTarget = {
	deploymentId: string;
	currentPlanSlug: ComputePlanSlug;
	initialPlanSlug: ComputePlanSlug;
	currentBillingTermMonths: DeployComponents["schemas"]["V2ComputePlanChangeQuoteRequest"]["target_billing_term_months"];
	currentFundingSource: NonNullable<
		DeployComponents["schemas"]["V2ComputePlanChangeQuoteRequest"]["funding_source"]
	>;
	status: string;
	paymentSourceOnly: boolean;
	cancelAtPeriodEnd: boolean;
	isPaidCompute: boolean;
	allowCombinedChange: boolean;
	projectedOperationName: string | null;
};

export function planChangeBillingTerm(
	value: number,
): DeployComponents["schemas"]["V2ComputePlanChangeQuoteRequest"]["target_billing_term_months"] {
	return value === 12 ? 12 : 1;
}

export function planChangeTargetUnavailableReason({
	canCreateCloudAgents,
	target,
}: {
	canCreateCloudAgents: boolean;
	target: PlanChangeTarget;
}): string | null {
	return planChangeUnavailableReason({
		canCreateCloudAgents,
		cancelAtPeriodEnd: target.cancelAtPeriodEnd,
		status: target.status,
		hasSubscriptionTarget: target.deploymentId.trim().length > 0,
	});
}
