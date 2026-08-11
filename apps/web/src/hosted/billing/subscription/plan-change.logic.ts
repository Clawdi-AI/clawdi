import type {
	ComputePlanChangeQuoteRequest,
	ComputePlanSlug,
	HostedDeployment,
} from "@/hosted/billing/contracts";
import { COMPUTE_BASIC_SLUG, COMPUTE_PERFORMANCE_SLUG } from "./subscription-utils";

export type PlanChangeSelection = Omit<ComputePlanChangeQuoteRequest, "subscription_id"> & {
	funding_source: NonNullable<ComputePlanChangeQuoteRequest["funding_source"]>;
};

const UNSIGNED_DECIMAL = /^(\d+)(?:\.(\d+))?$/;

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

/** Recover an active plan change from the authoritative deployment projection. */
export function activePlanChangeOperationName(
	deployment: Pick<HostedDeployment, "accepted_operation" | "resource">,
): string | null {
	const operation = deployment.accepted_operation;
	if (
		operation?.done !== false ||
		operation.metadata.verb !== "plan_change" ||
		operation.metadata.deploymentId !== deployment.resource.id
	) {
		return null;
	}
	return operation.name.trim() || null;
}

function isHostedComputeUpgradeIneligibilityReason(
	reason: string,
): reason is HostedComputeUpgradeIneligibilityReason {
	return Object.hasOwn(PERFORMANCE_UPGRADE_UNAVAILABLE_COPY, reason);
}

function performanceUpgradeEligibilityReasonCopy(reason: string | null): string {
	return reason !== null && isHostedComputeUpgradeIneligibilityReason(reason)
		? PERFORMANCE_UPGRADE_UNAVAILABLE_COPY[reason]
		: UNKNOWN_PERFORMANCE_UPGRADE_UNAVAILABLE_COPY;
}

function decimalParts(value: string): { units: bigint; scale: number } | null {
	const match = UNSIGNED_DECIMAL.exec(value.trim());
	if (!match) return null;
	const whole = match[1] ?? "0";
	const fraction = match[2] ?? "";
	return {
		units: BigInt(`${whole}${fraction}`),
		scale: fraction.length,
	};
}

function scaledUnits(parts: { units: bigint; scale: number }, scale: number): bigint {
	return parts.units * 10n ** BigInt(scale - parts.scale);
}

function decimalString(units: bigint, scale: number): string {
	const negative = units < 0n;
	const digits = (negative ? -units : units).toString().padStart(scale + 1, "0");
	const whole = scale === 0 ? digits : digits.slice(0, -scale);
	const fraction = scale === 0 ? "" : digits.slice(-scale).replace(/0+$/, "");
	return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/** Subtract a decimal-string debit without rounding through a JavaScript number. */
export function walletBalanceAfterDebit(
	balanceBeforeUsd: string,
	debitAmountUsd: string,
): string | null {
	const balance = decimalParts(balanceBeforeUsd);
	const debit = decimalParts(debitAmountUsd);
	if (!balance || !debit) return null;
	const scale = Math.max(balance.scale, debit.scale);
	return decimalString(scaledUnits(balance, scale) - scaledUnits(debit, scale), scale);
}

export function defaultPlanChangeSelection(
	currentPlanSlug: ComputePlanSlug,
	currentBillingTermMonths: ComputePlanChangeQuoteRequest["target_billing_term_months"],
	fundingSource: PlanChangeSelection["funding_source"],
): PlanChangeSelection {
	return {
		target_plan_slug:
			currentPlanSlug === COMPUTE_PERFORMANCE_SLUG ? COMPUTE_BASIC_SLUG : COMPUTE_PERFORMANCE_SLUG,
		target_billing_term_months: currentBillingTermMonths,
		funding_source: fundingSource,
	};
}

export function isSamePlanChangeSelection(
	selection: PlanChangeSelection,
	currentPlanSlug: ComputePlanSlug,
	currentBillingTermMonths: number,
): boolean {
	return (
		selection.target_plan_slug === currentPlanSlug &&
		selection.target_billing_term_months === currentBillingTermMonths
	);
}

export function planChangeUnavailableReason({
	canCreateCloudAgents,
	cancelAtPeriodEnd,
	status,
	subscriptionId,
}: {
	canCreateCloudAgents: boolean;
	cancelAtPeriodEnd: boolean;
	status: string;
	subscriptionId: number | null;
}): string | null {
	if (!canCreateCloudAgents) return "Plan changes are temporarily unavailable.";
	if (cancelAtPeriodEnd)
		return "Resume this subscription before changing its plan or billing term.";
	if (!subscriptionId)
		return "Plan changes will be available after subscription details finish syncing.";
	if (status !== "active") {
		return "Resolve the subscription status before changing its plan or billing term.";
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
