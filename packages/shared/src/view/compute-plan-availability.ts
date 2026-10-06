import type { DeployComponents, DeploymentRead } from "../api";

type HostedDeployment = DeploymentRead;
type ComputePlanSlug = DeployComponents["schemas"]["V2HostedDeployRequest"]["compute_plan_slug"];

import { COMPUTE_PERFORMANCE_SLUG } from "./compute-subscriptions";

type HostedComputeUpgradeIneligibilityReason = NonNullable<
	HostedDeployment["upgrade_eligibility"]["reason"]
>;

const PERFORMANCE_UPGRADE_UNAVAILABLE_COPY = {
	deployment_deleted: "This agent was deleted. Create a new agent to use Performance.",
	compute_basic_required: "Only agents on the Basic plan can upgrade to Performance.",
	compute_subscription_unavailable:
		"Couldn't load this agent's subscription details. Check again in a moment.",
	included_basic_required:
		"This agent's subscription is managed separately. Change its plan from the subscription controls.",
	compute_subscription_not_active:
		"This agent's no-cost subscription isn't active yet, so it can't upgrade. You weren't charged and don't need to do anything. Check again later.",
	compute_subscription_canceling:
		"This agent's subscription is set to cancel. Resume it, then try again.",
	deployment_state_unknown:
		"Couldn't load this agent's current state. Check again before upgrading.",
	deployment_must_be_running_or_stopped:
		"Wait until this agent is running or stopped, then try again.",
	upgrade_already_in_progress:
		"An upgrade to Performance is already in progress. Wait for it to finish.",
} satisfies Record<HostedComputeUpgradeIneligibilityReason, string>;

const UNKNOWN_PERFORMANCE_UPGRADE_UNAVAILABLE_COPY =
	"This agent can't be upgraded right now. Check again later, or contact support if this continues.";

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
		return "Only Basic agents without a separate subscription can upgrade here. Use this agent's subscription controls instead.";
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
