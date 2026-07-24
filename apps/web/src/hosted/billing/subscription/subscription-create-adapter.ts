import { acceptDeclarativeOperation } from "@/hosted/billing/billing-client";
import type {
	CheckoutRequest,
	CheckoutResult,
	ComputePlanSlug,
	ComputeSubscriptionQuoteRequest,
	ComputeSubscriptionQuoteResponse,
	DeployRequest,
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
	target: SubscriptionCreateTarget;
	uiMode: string;
	idempotencyKey: string;
	quote: SubscriptionCreateQuoteView | null;
};

export type SubscriptionCreateOutcomeView =
	| {
			flowType: "checkout";
			checkout: CheckoutResult;
	  }
	| {
			flowType: "subscription_activation";
			deploymentId: string;
			deployRequestId: string | null;
	  };

export function subscriptionCreateQuoteRequest(
	selection: SubscriptionCreateSelection | null,
): ComputeSubscriptionQuoteRequest | null {
	if (!selection) return null;
	return {
		plan_slug: selection.planSlug,
		billing_term_months: selection.billingTermMonths,
		funding_source: selection.fundingSource,
	};
}

function decimalString(value: string | null | undefined, field: string): string {
	if (value === null || value === undefined || value.trim() === "") {
		throw new Error(`Subscription quote is missing ${field}.`);
	}
	return value;
}

function requiredQuoteNumber(value: number | null | undefined, field: string): number {
	if (value === null || value === undefined) {
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
					balanceBeforeCredits: decimalString(quote.balance_before_credits, "the wallet balance"),
					exactDebitCredits: decimalString(quote.debit_credits, "the exact wallet debit"),
					exactDebitCents: quote.term_price_cents,
					balanceAfterCredits: decimalString(
						quote.balance_after_credits,
						"the post-debit wallet balance",
					),
					pointsPerUsd: requiredQuoteNumber(quote.points_per_usd, "the wallet conversion rate"),
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
	const body: CheckoutRequest = {
		plan_slug: selection.planSlug,
		billing_term_months: selection.billingTermMonths,
		funding_source: selection.fundingSource,
		ui_mode: request.uiMode,
		...(target.kind === "new_deployment"
			? {
					deploy_config: {
						...target.deployConfig,
						// The post-#980 create path is funding-driven. Bind its pending
						// deploy request to the same stable logical-intent key as checkout.
						deploy_request_id: target.deployConfig.deploy_request_id ?? request.idempotencyKey,
					},
				}
			: { upgrade_deployment_id: target.deploymentId }),
		...(selection.fundingSource === "wallet" && request.quote
			? { quote: request.quote.serverQuote }
			: {}),
	};
	return { body, idempotencyKey: request.idempotencyKey };
}

export function subscriptionCreateOutcome(result: CheckoutResult): SubscriptionCreateOutcomeView {
	if (result.flow_type !== "subscription_activation") {
		return { flowType: "checkout", checkout: result };
	}
	return {
		flowType: "subscription_activation",
		deploymentId: acceptDeclarativeOperation(
			{ deploymentId: result.deployment_id, operation: null },
			"Wallet activation did not accept a deployment target.",
		).deploymentId,
		deployRequestId: result.deploy_request_id ?? null,
	};
}
