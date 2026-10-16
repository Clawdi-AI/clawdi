import {
	isWalletToCardSwitchSelection,
	type PlanChangeSelection,
	shouldResetUnacceptedPlanChangeQuote as shouldResetQuoteFailure,
} from "@clawdi/shared/view";
import type { ComputePlanSlug } from "@/hosted/billing/contracts";
import {
	BillingApiError,
	isPaymentMethodRequiredError,
	PlanChangeTerminalError,
} from "@/hosted/billing/errors";

export {
	activePlanChangeOperationName,
	defaultPlanChangeSelection,
	isCombinedPaidPlanChange,
	isFundingSourceOnlySelection,
	isFundingSourceSwitchQuote,
	isSamePlanChangeSelection,
	isValidFundingSourceSwitchQuote,
	isValidPaidPlanChangeQuote,
	isWalletToCardSwitchSelection,
	type PlanChangeSelection,
	performanceUpgradeUnavailableReason,
	planChangeNeedsOffer,
	planChangeNeedsWalletBalance,
	planChangeUnavailableReason,
	selectPlanChangeFundingSource,
	selectPlanChangeOffer,
	visiblePlanChangeOperationName,
	walletBalanceAfterDebit,
} from "@clawdi/shared/view";

export function shouldResetUnacceptedPlanChangeQuote(error: unknown): boolean {
	return (
		error instanceof BillingApiError &&
		shouldResetQuoteFailure({
			status: error.status,
			detail: error.detail,
			terminal: error instanceof PlanChangeTerminalError,
		})
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
