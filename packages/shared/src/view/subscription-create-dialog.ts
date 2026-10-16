import type { DeployComponents } from "../api";
import { HOSTED_WALLET_FUNDING_ERROR_COPY } from "../api/subscription-create";

type ReusableSubscription = DeployComponents["schemas"]["V2ComputeReusableSubscriptionItem"];
type SubscriptionQuoteRequest = DeployComponents["schemas"]["V2ComputeSubscriptionQuoteRequest"];

export type SubscriptionFundingSource = SubscriptionQuoteRequest["funding_source"];
export type SubscriptionBillingTermMonths = NonNullable<
	SubscriptionQuoteRequest["billing_term_months"]
>;

export function supportedBillingTerm(value: number): SubscriptionBillingTermMonths | null {
	return value === 1 || value === 12 ? value : null;
}

/** UI selection for the rail-neutral subscription creation flow. */
export type SubscriptionCreateSelection = {
	planSlug: ReusableSubscription["plan_slug"];
	billingTermMonths: SubscriptionBillingTermMonths;
	fundingSource: SubscriptionFundingSource;
};

export type SubscriptionSource =
	| { mode: "included" }
	| { mode: "existing"; subscriptionId: string }
	| { mode: "new" };

const NEW_SUBSCRIPTION_SOURCE: SubscriptionSource = { mode: "new" };

/**
 * Web assigns only card and Wallet subscriptions. Store subscriptions are bought and
 * assigned in the Clawdi app; server admission selects them without a Web choice.
 */
export function isWebSelectableSubscription(
	subscription: Pick<ReusableSubscription, "funding_source">,
): boolean {
	return subscription.funding_source === "stripe" || subscription.funding_source === "wallet";
}

export function resolveSubscriptionSource({
	includedAvailable,
	reusableSubscriptions,
	selected,
}: {
	includedAvailable: boolean | undefined;
	reusableSubscriptions: readonly ReusableSubscription[] | undefined;
	selected: SubscriptionSource | null;
}): SubscriptionSource | null {
	if (includedAvailable === undefined || reusableSubscriptions === undefined) return selected;
	const selectable = reusableSubscriptions.filter(isWebSelectableSubscription);
	if (selected?.mode === "included" && !includedAvailable) selected = null;
	if (selected?.mode === "existing") {
		const subscriptionId = selected.subscriptionId;
		if (!selectable.some((subscription) => subscription.subscription_id === subscriptionId)) {
			selected = null;
		}
	}
	if (selected) return selected;
	return !includedAvailable && selectable.length === 0 ? NEW_SUBSCRIPTION_SOURCE : null;
}

/** Null for store subscriptions, which never use the hosted checkout flow. */
export function existingSubscriptionCreateSelection(
	subscription: ReusableSubscription,
): SubscriptionCreateSelection | null {
	if (subscription.funding_source !== "stripe" && subscription.funding_source !== "wallet") {
		return null;
	}
	return {
		planSlug: subscription.plan_slug,
		billingTermMonths: subscription.billing_term_months,
		fundingSource: subscription.funding_source,
	};
}

/** Web's "Choose a paid subscription" dialog copy, shared with the app's sheet. */
export const subscriptionCreateCopy = {
	title: "Choose a paid subscription",
	description: "Assign an available subscription or start a new one for this agent.",
	computePlan: "Compute plan",
	billingTerm: "Billing term",
	fundingSource: "Funding source",
	card: "Card",
	wallet: "Wallet",
	cancel: "Cancel",
	priceUnavailableTitle: "Plan price unavailable",
	priceUnavailableDescription: "Refresh the page before starting a paid subscription.",
	gettingQuote: "Getting the exact wallet debit…",
	quoteFailed: "Couldn’t get subscription quote",
	insufficientBalanceTitle: HOSTED_WALLET_FUNDING_ERROR_COPY.insufficientBalanceTitle,
	insufficientBalanceDescription: HOSTED_WALLET_FUNDING_ERROR_COPY.subscription.insufficientBalance,
	topUp: "Top up wallet",
	temporarilyUnavailable: "Temporarily unavailable",
	useSubscription: "Use subscription",
	payFromWallet: (amount: string) => `Pay ${amount} from wallet`,
	reviewWalletQuote: "Review wallet quote",
	continueToCardCheckout: "Continue to card checkout",
	assignedTitle: "Subscription assigned",
	startedTitle: "Subscription started",
	assignedDescription: "The agent's plan updates after the existing subscription is assigned.",
	walletPaidDescription: (amount: string) =>
		`${amount} was paid from your wallet. The agent's plan updates after payment is projected.`,
	cardPaidDescription:
		"Card payment was confirmed. The agent's plan updates after payment is projected.",
	checkoutFailedTitle: "Couldn’t start checkout",
	checkoutUrlMissing: "No checkout URL was returned. Try again.",
	unavailableTitle: "Subscription no longer available",
	unavailableDescription: "Choose a current reusable subscription or start a new one.",
	failedTitle: "Couldn’t start subscription",
} as const;
