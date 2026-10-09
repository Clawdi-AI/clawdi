import type { DeployComponents } from "../api";
import { billingTermLabel, billingTermSuffix, formatCurrencyCents } from "./billing-format";
import type { ComputeSubscriptionCardView } from "./compute-subscription-card";
import { computeTierLabel } from "./compute-subscriptions";
import { formatShortDate } from "./format";
import {
	storeProviderLabel,
	storeSubscriptionCopy,
	storeSubscriptionDate,
	storeSubscriptionStatus,
} from "./store-management";

export const subscriptionSourceCopy = {
	includedTitle: "Basic plan",
	includedDescription: "Use your included Basic entitlement.",
	included: "Included",
	dueNow: "$0 due now",
	newTitle: "New paid subscription",
	newDescription: "Choose a plan, billing term, and payment source.",
} as const;

export const deployFormCopy = {
	name: "Name in Clawdi",
	timezone: "Timezone",
	deploy: "Deploy",
	chooseSource: "Choose a subscription source.",
	billingTerm: "Billing term",
	paymentMethod: "Payment method",
	cardTitle: "Card subscription",
	cardDescription: "Recurring subscription via Stripe. Manage or cancel anytime.",
	trialTitle: "Free trial",
	trialDescription: "No card required. Add a payment method to continue after your trial.",
	walletTitle: "Wallet balance",
	walletDescription: "Paid upfront from your wallet balance. Renews from wallet.",
} as const;

export function deployConfigurationSummary(runtime: string, ai: string, compute: string): string {
	return [runtime, ai, `${compute} plan`].filter(Boolean).join(" · ");
}

export function deployComputeResourceLabels(vcpu: number, ramGb: number, diskGb: number) {
	return [`${vcpu} vCPU`, `${ramGb} GB RAM`, `${diskGb} GB storage`];
}

type ReusableSubscription = DeployComponents["schemas"]["V2ComputeReusableSubscriptionItem"];

export type ReusableSubscriptionChoiceView = {
	title: "Basic" | "Performance";
	description: string;
	status: ComputeSubscriptionCardView["status"];
	payment: { kind: "store" | "wallet" | "card"; label: string };
	facts: { id: "term" | "payment" | "date" | "price"; label: string; value: string }[];
};

/** Web's existing-subscription card in the deploy wizard: plan, status, term, payment and date. */
export function reusableSubscriptionChoiceView(
	subscription: ReusableSubscription,
): ReusableSubscriptionChoiceView {
	const store = subscription.funding_source === "store";
	const storeManagement = store ? subscription.store_management : null;
	const payment = store
		? ({ kind: "store", label: storeProviderLabel(storeManagement) } as const)
		: subscription.funding_source === "wallet"
			? ({ kind: "wallet", label: "Wallet" } as const)
			: ({ kind: "card", label: "Card" } as const);
	const canceling = subscription.status === "canceling" || subscription.cancel_at_period_end;
	const storeDate = storeSubscriptionDate(storeManagement);
	const dateLabel = formatShortDate(
		storeDate?.at ?? subscription.current_period_end ?? subscription.entitled_until,
	);
	const dateTitle = store
		? storeDate?.kind === "renews"
			? "Renews"
			: "Ends"
		: canceling
			? "Ends"
			: "Renews";
	// Store prices are set per storefront; no Clawdi price is shown for them.
	const priceLabel =
		store || subscription.price_cents == null
			? null
			: `${formatCurrencyCents(subscription.price_cents, subscription.currency)}${billingTermSuffix(subscription.billing_term_months)}`;
	const fallbackStatus: ComputeSubscriptionCardView["status"] = canceling
		? { label: "Canceling", tone: "warning" }
		: subscription.status === "trialing"
			? { label: "Trial", tone: "info" }
			: { label: "Active", tone: "success" };
	return {
		title: computeTierLabel(subscription.plan_slug),
		description: store ? storeSubscriptionCopy.availableInApp : subscriptionSourceCopy.dueNow,
		status: store ? storeSubscriptionStatus(storeManagement, fallbackStatus) : fallbackStatus,
		payment,
		facts: [
			{ id: "term", label: "Term", value: billingTermLabel(subscription.billing_term_months) },
			{ id: "payment", label: "Payment", value: payment.label },
			{ id: "date", label: dateTitle, value: dateLabel },
			...(priceLabel ? [{ id: "price" as const, label: "Plan price", value: priceLabel }] : []),
		],
	};
}
