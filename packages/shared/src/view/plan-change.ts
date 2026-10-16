import type {
	ComputePlanChangeQuoteRequest,
	ComputePlanChangeQuoteResponse,
} from "../api/plan-change";
import { subtractDecimals } from "./billing-format";
import type { PlanChangeTarget } from "./compute-plan-availability";
import { COMPUTE_BASIC_SLUG, COMPUTE_PERFORMANCE_SLUG } from "./compute-subscriptions";

type ComputePlanSlug = PlanChangeTarget["currentPlanSlug"];

export type PlanChangeSelection = Omit<
	ComputePlanChangeQuoteRequest,
	"subscription_id" | "deployment_id"
> & {
	funding_source: NonNullable<ComputePlanChangeQuoteRequest["funding_source"]>;
};

export type PlanChangeManagementMode = "plan-billing" | "payment-source";

export function planChangeTargetFingerprint(target: PlanChangeTarget): string {
	return [
		target.deploymentId.trim(),
		target.currentPlanSlug,
		target.initialPlanSlug,
		target.currentBillingTermMonths,
		target.currentFundingSource,
		target.status,
		target.paymentSourceOnly ? "payment-source-only" : "full-management",
		target.cancelAtPeriodEnd ? "canceling" : "renewing",
		target.isPaidCompute ? "paid-compute" : "included-compute",
		target.allowCombinedChange ? "combined-change" : "single-change",
	].join(":");
}

export function visiblePlanChangeOperationName(
	projectedOperationName: string | null,
	ignoredOperationNames: readonly string[],
): string | null {
	return projectedOperationName !== null && ignoredOperationNames.includes(projectedOperationName)
		? null
		: projectedOperationName;
}

/**
 * Hosted refused an unaccepted change because its quote expired (an untyped 409 whose
 * detail names the expiry): drop the quote and request a fresh one. Accepted changes that
 * failed later are never this case.
 */
export function shouldResetUnacceptedPlanChangeQuote({
	status,
	detail,
	terminal,
}: {
	status: number;
	detail: string | null;
	terminal: boolean;
}): boolean {
	return (
		status === 409 && !terminal && detail !== null && /quote.*expired|expired.*quote/i.test(detail)
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

export function planChangeManagementModes({
	allowCombinedChange,
	paymentSourceOnly,
	hasUsablePlans,
}: {
	allowCombinedChange: boolean;
	paymentSourceOnly: boolean;
	hasUsablePlans: boolean;
}): {
	hasModePicker: boolean;
	initialMode: PlanChangeManagementMode;
	planBillingAvailable: boolean;
} {
	const planBillingAvailable = allowCombinedChange || hasUsablePlans;
	return {
		hasModePicker: !allowCombinedChange && !paymentSourceOnly,
		initialMode: paymentSourceOnly || !planBillingAvailable ? "payment-source" : "plan-billing",
		planBillingAvailable,
	};
}

export function planChangeDialogStep({
	hasAcceptedChange,
	hasQuote,
	paymentMethodRequired,
}: {
	hasAcceptedChange: boolean;
	hasQuote: boolean;
	paymentMethodRequired: boolean;
}): "pending" | "payment_method_required" | "quote" | "selection" {
	if (hasAcceptedChange) return "pending";
	if (paymentMethodRequired) return "payment_method_required";
	if (hasQuote) return "quote";
	return "selection";
}

type QuoteKind = "funding_source_switch" | "immediate_upgrade" | "scheduled_downgrade";

function quoteKind(quote: Pick<ComputePlanChangeQuoteResponse, "change_kind"> | null): QuoteKind {
	return quote?.change_kind === "funding_source_switch"
		? "funding_source_switch"
		: quote?.change_kind === "immediate_upgrade"
			? "immediate_upgrade"
			: "scheduled_downgrade";
}

/** Web's plan-change dialog and controller copy, shared with the app's sheet. */
export const planChangeCopy = {
	walletFunding: {
		insufficientBalance: "Top up the shortfall, then request a fresh plan-change quote.",
		refundDebt: "Top up before confirming this wallet-funded plan change.",
	},
	portalUnavailableTitle: "Billing portal unavailable",
	portalUnavailableDescription: "Refresh this page and try again in a moment.",
	openBillingFailed: "Couldn’t open billing",
	paymentSourceOnlyTitle: "Only the payment source can be changed",
	paymentSourceOnlyDescription:
		"This subscription can’t change plan or billing term while past due. Choose a different payment source to continue.",
	oneChangeTitle: "Choose one subscription change",
	oneChangeDescription:
		"Change the plan or billing term using the current payment source, or change only the payment source.",
	quoteMismatchTitle: "Couldn’t verify subscription change",
	quoteMismatchDescription: "The quote did not match the requested change. Request a fresh quote.",
	quoteFailed: "Couldn’t quote subscription change",
	downgradeScheduledTitle: "Downgrade scheduled",
	downgradeScheduledDescription: (date: string) =>
		`Your current plan remains active until ${date}.`,
	paymentMethodUpdatedTitle: "Payment method updated",
	paymentMethodUpdatedDescription: (fundingSource: PlanChangeSelection["funding_source"]) =>
		fundingSource === "wallet"
			? "Future renewals will use wallet."
			: "Future renewals will use card.",
	planChangedTitle: "Plan changed",
	planChangedDescription: "Your compute subscription has been updated.",
	stillWaitingTitle: "Still waiting for confirmation",
	stillWaitingNotice:
		"Don't submit another change. Check again in a few minutes — checking won't resubmit or charge. Contact support if it doesn't finish.",
	stillWaitingDescription:
		"Don't submit another change. You can close this window and check again in a few minutes. Contact support if it doesn't finish.",
	quoteStaleTitle: "Subscription quote is no longer current",
	quoteStaleDescription: "Review the latest choices and request a fresh quote.",
	updateFailed: "Couldn’t update subscription",
	cardRequiredTitle: "A card is required",
	cardRequiredDescription:
		"Opening billing settings does not complete this payment source change. After you return, request a fresh quote and submit it again.",
	close: "Close",
	back: "Back",
	cancel: "Cancel",
	managePaymentMethods: "Manage payment methods",
	paymentSource: "Payment source",
	dueNow: "Due now",
	effectiveDate: "Effective date",
	subscription: "Subscription",
	newSubscription: "New subscription",
	card: "Card",
	wallet: "Wallet",
	futureRenewalsUse: (fundingSource: PlanChangeSelection["funding_source"]) =>
		`Future renewals use ${fundingSource === "wallet" ? "wallet" : "card"}`,
	fundingSwitchDescription: (fundingSource: PlanChangeSelection["funding_source"]) =>
		`Your plan, billing term, price, and renewal date stay the same. This change does not ${
			fundingSource === "wallet" ? "debit your wallet" : "charge your card"
		} today.`,
	quoteTitle: (quote: Pick<ComputePlanChangeQuoteResponse, "change_kind"> | null) =>
		({
			funding_source_switch: "Confirm payment source change",
			immediate_upgrade: "Confirm immediate upgrade",
			scheduled_downgrade: "Schedule downgrade",
		})[quoteKind(quote)],
	confirmLabel: (quote: Pick<ComputePlanChangeQuoteResponse, "change_kind"> | null) =>
		({
			funding_source_switch: "Update payment source",
			immediate_upgrade: "Confirm upgrade",
			scheduled_downgrade: "Schedule downgrade",
		})[quoteKind(quote)],
	busyLabel: (quote: Pick<ComputePlanChangeQuoteResponse, "change_kind"> | null) =>
		({
			funding_source_switch: "Updating payment source…",
			immediate_upgrade: "Confirming plan change…",
			scheduled_downgrade: "Scheduling downgrade…",
		})[quoteKind(quote)],
	pendingTitle: "Check subscription change status",
	pendingDescription:
		"This subscription change was already accepted. Checking its status will not submit another request or charge.",
	cardRequiredStepTitle: "Add a card to continue",
	cardRequiredStepDescription:
		"Add or choose a card in secure billing settings, then return and request a new quote.",
	changePaymentSourceTitle: "Change payment source",
	manageTitle: "Manage compute subscription",
	changeTitle: "Change compute subscription",
	fundingSwitchQuoteDescription: (fundingSource: PlanChangeSelection["funding_source"]) =>
		`No payment is due now. Future renewals will use ${fundingSource === "wallet" ? "wallet" : "card"}.`,
	upgradeQuoteDescription:
		"The quoted proration is charged now. The new plan applies after payment is confirmed.",
	downgradeQuoteDescription: (date: string) => `The current plan remains active until ${date}.`,
	paymentSourceModeDescription:
		"Choose a new payment source. Your plan and billing term stay the same; eligibility is verified before the change is applied.",
	combinedSelectionDescription:
		"Choose a compute plan, billing term, and payment source, then review the exact price and timing.",
	planSelectionDescription:
		"Choose a compute plan and billing term. Your payment source stays the same.",
	checkStatus: "Check status",
	checkingStatus: "Checking status…",
	noChargeTodayTitle: "No charge today",
	noChargeTodayDescription:
		"The downgrade is scheduled for the current period boundary. Your current plan and resources remain active until then.",
	insufficientBalanceTitle: "Not enough wallet balance",
	insufficientBalanceDescription: "Top up the shortfall, then request a fresh price.",
	topUp: "Top up wallet",
	walletQuoteIncompleteTitle: "Wallet quote is incomplete",
	walletQuoteIncompleteDescription: "Request a fresh quote before confirming this plan change.",
	invalidSwitchQuoteTitle: "Payment source quote is invalid",
	invalidSwitchQuoteDescription:
		"A payment source-only change must keep the current plan and term, have $0 due now, and apply to future renewals. Go back and request a fresh quote.",
	planAndBilling: "Plan & billing",
	managementModeLabel: "Subscription management mode",
	currentPlan: "Current plan",
	billingTerm: "Billing term",
	computePlan: "Compute plan",
	loadingWalletBalance: "Loading wallet balance…",
	listedPrice: (price: string, billingTermMonths: number) =>
		`Listed recurring price ${price}${billingTermMonths === 1 ? "/month" : "/year"}`,
	reviewChange: "Review change",
} as const;
