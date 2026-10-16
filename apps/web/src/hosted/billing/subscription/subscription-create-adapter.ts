import {
	buildHostedDeployCheckoutRequest,
	buildHostedDeploySubscriptionQuoteRequest,
	type HostedDeployCheckoutUiMode,
	hostedSubscriptionActivationTarget,
	hostedSubscriptionQuoteWalletDebit,
} from "@clawdi/shared/api";
import type { SubscriptionCreateSelection } from "@clawdi/shared/view";
import type { CheckoutOperationResult } from "@/hosted/billing/billing-client";
import type { CheckoutReturnNavigationTarget } from "@/hosted/billing/checkout-return";
import type {
	CheckoutRequest,
	ComputeSubscriptionQuoteRequest,
	ComputeSubscriptionQuoteResponse,
	DeployRequest,
	SubscriptionSelection,
} from "@/hosted/billing/contracts";
import type { WalletDebitSummary } from "@/hosted/billing/wallet/wallet-debit-summary";

export {
	existingSubscriptionCreateSelection,
	isWebSelectableSubscription,
	resolveSubscriptionSource,
	type SubscriptionBillingTermMonths,
	type SubscriptionCreateSelection,
	type SubscriptionFundingSource,
	type SubscriptionSource,
	supportedBillingTerm,
} from "@clawdi/shared/view";

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
			checkout: Extract<CheckoutOperationResult, { flow_type: "checkout_session" }>;
	  }
	| {
			flowType: "subscription_activation";
			target: CheckoutReturnNavigationTarget;
			currentPeriodEnd: string | null;
			entitledUntil: string | null;
	  };

export function subscriptionCreateQuoteRequest(
	selection: SubscriptionCreateSelection | null,
): ComputeSubscriptionQuoteRequest | null {
	if (!selection) return null;
	return buildHostedDeploySubscriptionQuoteRequest(selection);
}

export function subscriptionCreateQuoteView(
	selection: SubscriptionCreateSelection,
	quote: ComputeSubscriptionQuoteResponse,
): SubscriptionCreateQuoteView {
	return {
		selection,
		termPriceCents: quote.term_price_cents,
		currency: quote.currency,
		previewId: quote.preview_invoice_id ?? null,
		expiresAt: quote.expires_at,
		walletDebit: hostedSubscriptionQuoteWalletDebit(quote),
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

export function subscriptionCreateOutcome(
	result: CheckoutOperationResult,
): SubscriptionCreateOutcomeView {
	if (result.flow_type !== "subscription_activation") {
		return { flowType: "checkout", checkout: result };
	}
	const target: CheckoutReturnNavigationTarget = hostedSubscriptionActivationTarget(result);
	return {
		flowType: "subscription_activation",
		target,
		currentPeriodEnd: result.current_period_end ?? null,
		entitledUntil: result.entitled_until ?? null,
	};
}
