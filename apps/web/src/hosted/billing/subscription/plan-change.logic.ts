import type {
	ComputePlanChangeQuoteRequest,
	ComputePlanChangeQuoteResponse,
	ComputePlanSlug,
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

export { activePlanChangeOperationName } from "@clawdi/shared/view";

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

export {
	performanceUpgradeUnavailableReason,
	planChangeUnavailableReason,
} from "@clawdi/shared/view";
