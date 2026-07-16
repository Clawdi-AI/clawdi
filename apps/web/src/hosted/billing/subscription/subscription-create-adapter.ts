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
			subscriptionId: number;
			invoiceId: string | null;
			deploymentId: string | null;
			deployRequestId: string | null;
			exactDebitCredits: string;
			balanceAfterCredits: string;
			periodStart: string;
			periodEnd: string;
			entitledUntil: string;
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
					pointsPerUsd: requiredNumber(quote.points_per_usd, "the wallet conversion rate"),
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
			? { deploy_config: target.deployConfig }
			: { upgrade_deployment_id: target.deploymentId }),
		...(selection.fundingSource === "wallet" && request.quote
			? { quote: request.quote.serverQuote }
			: {}),
	};
	return { body, idempotencyKey: request.idempotencyKey };
}

function requiredNumber(value: number | null | undefined, field: string): number {
	if (value === null || value === undefined) {
		throw new Error(`Subscription activation is missing ${field}.`);
	}
	return value;
}

function requiredString(value: string | null | undefined, field: string): string {
	if (!value) throw new Error(`Subscription activation is missing ${field}.`);
	return value;
}

export function subscriptionCreateOutcome(result: CheckoutResult): SubscriptionCreateOutcomeView {
	if (result.flow_type !== "subscription_activation") {
		return { flowType: "checkout", checkout: result };
	}
	return {
		flowType: "subscription_activation",
		subscriptionId: requiredNumber(result.subscription_id, "the subscription id"),
		invoiceId: result.invoice_id ?? null,
		deploymentId: result.deployment_id ?? null,
		deployRequestId: result.deploy_request_id ?? null,
		exactDebitCredits: requiredString(result.debited_credits, "the exact wallet debit"),
		balanceAfterCredits: requiredString(
			result.balance_after_credits,
			"the post-debit wallet balance",
		),
		periodStart: requiredString(result.current_period_start, "the period start"),
		periodEnd: requiredString(result.current_period_end, "the period end"),
		entitledUntil: requiredString(result.entitled_until, "the entitlement end"),
	};
}
