import {
	buildHostedDeployCheckoutRequest,
	buildHostedDeploySubscriptionQuoteRequest,
	type HostedDeployCheckoutUiMode,
} from "@clawdi/shared/api";
import {
	acceptDeclarativeOperation,
	type CheckoutOperationResult,
} from "@/hosted/billing/billing-client";
import type {
	CheckoutRequest,
	ComputePlanSlug,
	ComputeSubscriptionQuoteRequest,
	ComputeSubscriptionQuoteResponse,
	DeployRequest,
	ReusableSubscription,
	SubscriptionSelection,
} from "@/hosted/billing/contracts";
import type { WalletDebitSummary } from "@/hosted/billing/wallet/wallet-debit-summary";

export type SubscriptionFundingSource = ComputeSubscriptionQuoteRequest["funding_source"];
export type SubscriptionBillingTermMonths = NonNullable<
	ComputeSubscriptionQuoteRequest["billing_term_months"]
>;

export function supportedBillingTerm(value: number): SubscriptionBillingTermMonths | null {
	return value === 1 || value === 12 ? value : null;
}

/** UI selection for the rail-neutral subscription creation flow. */
export type SubscriptionCreateSelection = {
	planSlug: ComputePlanSlug;
	billingTermMonths: SubscriptionBillingTermMonths;
	fundingSource: SubscriptionFundingSource;
};

export type SubscriptionSource =
	| { mode: "included" }
	| { mode: "existing"; subscriptionId: string }
	| { mode: "new" };

const NEW_SUBSCRIPTION_SOURCE: SubscriptionSource = { mode: "new" };

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
	if (selected?.mode === "included" && !includedAvailable) selected = null;
	if (selected?.mode === "existing") {
		const subscriptionId = selected.subscriptionId;
		if (
			!reusableSubscriptions.some((subscription) => subscription.subscription_id === subscriptionId)
		) {
			selected = null;
		}
	}
	if (selected) return selected;
	return !includedAvailable && reusableSubscriptions.length === 0 ? NEW_SUBSCRIPTION_SOURCE : null;
}

/** Presentation model plus the exact server assertion used at confirmation. */
export type SubscriptionCreateQuoteView = {
	selection: SubscriptionCreateSelection;
	termPriceCents: number;
	currency: string;
	previewId: string | null;
	expiresAt: string;
	walletDebit: WalletDebitSummary | null;
	serverQuote: ComputeSubscriptionQuoteResponse;
};

export type SubscriptionCreateTarget =
	| { kind: "new_deployment"; deployConfig: DeployRequest }
	| { kind: "terminal_fallback"; deploymentId: string };

export type SubscriptionCreateRequestView = {
	selection: SubscriptionCreateSelection;
	subscriptionSelection: SubscriptionSelection;
	target: SubscriptionCreateTarget;
	uiMode: HostedDeployCheckoutUiMode;
	idempotencyKey: string;
	quote: SubscriptionCreateQuoteView | null;
};

export type SubscriptionCreateOutcomeView =
	| {
			flowType: "checkout";
			checkout: CheckoutOperationResult;
	  }
	| {
			flowType: "subscription_activation";
			deploymentId: string;
			deployRequestId: string | null;
			currentPeriodEnd: string | null;
			entitledUntil: string | null;
	  };

export function subscriptionCreateQuoteRequest(
	selection: SubscriptionCreateSelection | null,
): ComputeSubscriptionQuoteRequest | null {
	if (!selection) return null;
	return buildHostedDeploySubscriptionQuoteRequest(selection);
}

function decimalString(value: string | null | undefined, field: string): string {
	if (value === null || value === undefined || value.trim() === "") {
		throw new Error(`Subscription quote is missing ${field}.`);
	}
	return value;
}

export function subscriptionCreateQuoteView(
	selection: SubscriptionCreateSelection,
	quote: ComputeSubscriptionQuoteResponse,
): SubscriptionCreateQuoteView {
	const walletDebit =
		quote.funding_source === "wallet"
			? {
					balanceBeforeUsd: decimalString(quote.balance_before_usd, "the wallet balance"),
					debitAmountUsd: decimalString(quote.debit_amount_usd, "the exact wallet debit"),
					balanceAfterUsd: decimalString(quote.balance_after_usd, "the post-debit wallet balance"),
				}
			: null;
	return {
		selection,
		termPriceCents: quote.term_price_cents,
		currency: quote.currency,
		previewId: quote.preview_invoice_id ?? null,
		expiresAt: quote.expires_at,
		walletDebit,
		serverQuote: quote,
	};
}

export function subscriptionCreateRequest(request: SubscriptionCreateRequestView): {
	body: CheckoutRequest;
	idempotencyKey: string;
} {
	const { selection, target } = request;
	const body: CheckoutRequest = buildHostedDeployCheckoutRequest({
		selection,
		subscriptionSelection: request.subscriptionSelection,
		target:
			target.kind === "new_deployment"
				? { kind: "new_deployment", deployRequest: target.deployConfig }
				: { kind: "upgrade_deployment", deploymentId: target.deploymentId },
		idempotencyKey: request.idempotencyKey,
		quote: request.quote?.serverQuote ?? null,
		uiMode: request.uiMode,
	});
	return { body, idempotencyKey: request.idempotencyKey };
}

export function existingSubscriptionCreateSelection(
	subscription: ReusableSubscription,
): SubscriptionCreateSelection {
	return {
		planSlug: subscription.plan_slug,
		billingTermMonths: subscription.billing_term_months,
		fundingSource: subscription.funding_source,
	};
}

export function subscriptionCreateOutcome(
	result: CheckoutOperationResult,
): SubscriptionCreateOutcomeView {
	if (result.flow_type !== "subscription_activation") {
		return { flowType: "checkout", checkout: result };
	}
	return {
		flowType: "subscription_activation",
		deploymentId: acceptDeclarativeOperation(
			{ deploymentId: result.deployment_id, operation: null },
			"Wallet activation did not return an agent.",
		).deploymentId,
		deployRequestId: result.deploy_request_id ?? null,
		currentPeriodEnd: result.current_period_end ?? null,
		entitledUntil: result.entitled_until ?? null,
	};
}
