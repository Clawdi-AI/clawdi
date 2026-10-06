import type {
	ComputePlanChangeQuoteRequest,
	ComputePlanChangeQuoteResponse,
	ComputePlanSlug,
	HostedDeployment,
} from "@/hosted/billing/contracts";
import {
	BillingApiError,
	isPaymentMethodRequiredError,
	PlanChangeTerminalError,
} from "@/hosted/billing/errors";
import { subtractDecimals } from "@/hosted/billing/format";
import { COMPUTE_BASIC_SLUG, COMPUTE_PERFORMANCE_SLUG } from "./subscription-utils";

export type PlanChangeSelection = Omit<
	ComputePlanChangeQuoteRequest,
	"subscription_id" | "deployment_id"
> & {
	funding_source: NonNullable<ComputePlanChangeQuoteRequest["funding_source"]>;
};

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

export function visiblePlanChangeOperationName(
	projectedOperationName: string | null,
	ignoredOperationNames: readonly string[],
): string | null {
	return projectedOperationName !== null && ignoredOperationNames.includes(projectedOperationName)
		? null
		: projectedOperationName;
}

export function shouldResetUnacceptedPlanChangeQuote(error: unknown): boolean {
	return (
		error instanceof BillingApiError &&
		error.status === 409 &&
		!(error instanceof PlanChangeTerminalError) &&
		/quote.*expired|expired.*quote/i.test(error.detail)
	);
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

/** Subtract a decimal-string debit without rounding through a JavaScript number. */
export function walletBalanceAfterDebit(
	balanceBeforeUsd: string,
	debitAmountUsd: string,
): string | null {
	if (/^[+-]/.test(balanceBeforeUsd) || /^[+-]/.test(debitAmountUsd)) return null;
	return subtractDecimals(balanceBeforeUsd, debitAmountUsd);
}

export function defaultPlanChangeSelection(
	currentPlanSlug: ComputePlanSlug,
	currentBillingTermMonths: ComputePlanChangeQuoteRequest["target_billing_term_months"],
	fundingSource: PlanChangeSelection["funding_source"],
	initialPlanSlug: ComputePlanSlug = currentPlanSlug === COMPUTE_PERFORMANCE_SLUG
		? COMPUTE_BASIC_SLUG
		: COMPUTE_PERFORMANCE_SLUG,
): PlanChangeSelection {
	return {
		target_plan_slug: initialPlanSlug,
		target_billing_term_months: currentBillingTermMonths,
		funding_source: fundingSource,
	};
}

export function isSamePlanChangeSelection(
	selection: PlanChangeSelection,
	currentPlanSlug: ComputePlanSlug,
	currentBillingTermMonths: number,
	currentFundingSource: PlanChangeSelection["funding_source"],
): boolean {
	return (
		selection.target_plan_slug === currentPlanSlug &&
		selection.target_billing_term_months === currentBillingTermMonths &&
		selection.funding_source === currentFundingSource
	);
}

export function selectPlanChangeOffer(
	selection: PlanChangeSelection,
	targetPlanSlug: ComputePlanSlug,
	targetBillingTermMonths: PlanChangeSelection["target_billing_term_months"],
	currentFundingSource: PlanChangeSelection["funding_source"],
	allowCombinedChange: boolean,
): PlanChangeSelection {
	return {
		...selection,
		target_plan_slug: targetPlanSlug,
		target_billing_term_months: targetBillingTermMonths,
		funding_source: allowCombinedChange ? selection.funding_source : currentFundingSource,
	};
}

export function selectPlanChangeFundingSource(
	selection: PlanChangeSelection,
	fundingSource: PlanChangeSelection["funding_source"],
	currentPlanSlug: ComputePlanSlug,
	currentBillingTermMonths: PlanChangeSelection["target_billing_term_months"],
	allowCombinedChange: boolean,
): PlanChangeSelection {
	return {
		...selection,
		target_plan_slug: allowCombinedChange ? selection.target_plan_slug : currentPlanSlug,
		target_billing_term_months: allowCombinedChange
			? selection.target_billing_term_months
			: currentBillingTermMonths,
		funding_source: fundingSource,
	};
}

export function planChangeNeedsWalletBalance(
	selection: PlanChangeSelection,
	currentPlanSlug: ComputePlanSlug,
	currentBillingTermMonths: number,
): boolean {
	return (
		selection.funding_source === "wallet" &&
		(selection.target_plan_slug !== currentPlanSlug ||
			selection.target_billing_term_months !== currentBillingTermMonths)
	);
}

export function planChangeNeedsOffer(
	selection: PlanChangeSelection,
	currentPlanSlug: ComputePlanSlug,
	currentBillingTermMonths: number,
): boolean {
	return (
		selection.target_plan_slug !== currentPlanSlug ||
		selection.target_billing_term_months !== currentBillingTermMonths
	);
}

export function isCombinedPaidPlanChange(
	selection: PlanChangeSelection,
	currentPlanSlug: ComputePlanSlug,
	currentBillingTermMonths: number,
	currentFundingSource: PlanChangeSelection["funding_source"],
): boolean {
	const offerChanges =
		selection.target_plan_slug !== currentPlanSlug ||
		selection.target_billing_term_months !== currentBillingTermMonths;
	return offerChanges && selection.funding_source !== currentFundingSource;
}

export function isFundingSourceOnlySelection(
	selection: PlanChangeSelection,
	currentPlanSlug: ComputePlanSlug,
	currentBillingTermMonths: number,
	currentFundingSource: PlanChangeSelection["funding_source"],
): boolean {
	return (
		selection.target_plan_slug === currentPlanSlug &&
		selection.target_billing_term_months === currentBillingTermMonths &&
		selection.funding_source !== currentFundingSource
	);
}

export function isWalletToCardSwitchSelection(
	selection: PlanChangeSelection,
	currentPlanSlug: ComputePlanSlug,
	currentBillingTermMonths: number,
	currentFundingSource: PlanChangeSelection["funding_source"],
): boolean {
	return (
		currentFundingSource === "wallet" &&
		selection.funding_source === "stripe" &&
		selection.target_plan_slug === currentPlanSlug &&
		selection.target_billing_term_months === currentBillingTermMonths
	);
}

export function shouldRecoverWalletToCardSwitch(
	error: unknown,
	selection: PlanChangeSelection,
	currentPlanSlug: ComputePlanSlug,
	currentBillingTermMonths: number,
	currentFundingSource: PlanChangeSelection["funding_source"],
): boolean {
	return (
		isWalletToCardSwitchSelection(
			selection,
			currentPlanSlug,
			currentBillingTermMonths,
			currentFundingSource,
		) && isPaymentMethodRequiredError(error)
	);
}

export function isFundingSourceSwitchQuote(
	quote: Pick<ComputePlanChangeQuoteResponse, "change_kind"> | null,
): boolean {
	return quote?.change_kind === "funding_source_switch";
}

export function isValidFundingSourceSwitchQuote(
	quote: ComputePlanChangeQuoteResponse,
	selection: PlanChangeSelection,
	currentPlanSlug: ComputePlanSlug,
	currentBillingTermMonths: PlanChangeSelection["target_billing_term_months"],
	currentFundingSource: PlanChangeSelection["funding_source"],
): boolean {
	return (
		selection.funding_source !== currentFundingSource &&
		quote.change_kind === "funding_source_switch" &&
		quote.billing_effect === "future_renewals" &&
		quote.amount_cents === 0 &&
		quote.current_plan_slug === currentPlanSlug &&
		quote.target_plan_slug === currentPlanSlug &&
		quote.current_billing_term_months === currentBillingTermMonths &&
		quote.target_billing_term_months === currentBillingTermMonths &&
		selection.target_plan_slug === currentPlanSlug &&
		selection.target_billing_term_months === currentBillingTermMonths &&
		quote.funding_source === selection.funding_source
	);
}

export function isValidPaidPlanChangeQuote(
	quote: ComputePlanChangeQuoteResponse,
	selection: PlanChangeSelection,
	currentPlanSlug: ComputePlanSlug,
	currentBillingTermMonths: PlanChangeSelection["target_billing_term_months"],
	currentFundingSource: PlanChangeSelection["funding_source"],
): boolean {
	if (selection.funding_source !== currentFundingSource) {
		return isValidFundingSourceSwitchQuote(
			quote,
			selection,
			currentPlanSlug,
			currentBillingTermMonths,
			currentFundingSource,
		);
	}
	const billingEffectMatches =
		quote.change_kind === "immediate_upgrade"
			? quote.billing_effect === "immediate_proration"
			: quote.change_kind === "scheduled_downgrade" && quote.billing_effect === "period_end";
	return (
		billingEffectMatches &&
		quote.current_plan_slug === currentPlanSlug &&
		quote.current_billing_term_months === currentBillingTermMonths &&
		quote.target_plan_slug === selection.target_plan_slug &&
		quote.target_billing_term_months === selection.target_billing_term_months &&
		quote.funding_source === currentFundingSource
	);
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
