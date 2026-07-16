import { describe, expect, test } from "bun:test";
import type {
	CheckoutResult,
	ComputeSubscriptionQuoteResponse,
	DeployRequest,
} from "@/hosted/billing/contracts";
import {
	type SubscriptionCreateRequestView,
	subscriptionCreateOutcome,
	subscriptionCreateQuoteRequest,
	subscriptionCreateQuoteView,
	subscriptionCreateRequest,
} from "./subscription-create-adapter";

const deployConfig: DeployRequest = {
	compute_plan_slug: "compute_performance",
	runtime: "openclaw",
	ai_provider_auth_kind: "managed",
};

const walletQuote: ComputeSubscriptionQuoteResponse = {
	plan_slug: "compute_performance",
	billing_term_months: 12,
	funding_source: "wallet",
	currency: "usd",
	term_price_cents: 18_000,
	preview_invoice_id: "upcoming_in_annual",
	expires_at: "2026-07-16T00:05:00Z",
	debit_credits: "180000",
	points_per_usd: 1_000,
	balance_before_credits: "200000.25",
	balance_after_credits: "20000.25",
};

function createRequest(
	overrides: Partial<SubscriptionCreateRequestView> = {},
): SubscriptionCreateRequestView {
	const selection = {
		planSlug: "compute_performance" as const,
		billingTermMonths: 12 as const,
		fundingSource: "wallet" as const,
	};
	return {
		selection,
		target: { kind: "new_deployment", deployConfig },
		uiMode: "custom",
		idempotencyKey: "subscription-create-test",
		quote: subscriptionCreateQuoteView(selection, walletQuote),
		...overrides,
	};
}

describe("subscription creation adapter", () => {
	test("presents the exact annual wallet quote and post-debit balance", () => {
		const selection = createRequest().selection;
		expect(subscriptionCreateQuoteRequest(selection)).toEqual({
			plan_slug: "compute_performance",
			billing_term_months: 12,
			funding_source: "wallet",
		});
		expect(subscriptionCreateQuoteView(selection, walletQuote)).toEqual({
			selection,
			termPriceCents: 18_000,
			currency: "usd",
			previewId: "upcoming_in_annual",
			expiresAt: "2026-07-16T00:05:00Z",
			serverQuote: walletQuote,
			walletDebit: {
				balanceBeforeCredits: "200000.25",
				exactDebitCredits: "180000",
				exactDebitCents: 18_000,
				balanceAfterCredits: "20000.25",
				pointsPerUsd: 1_000,
			},
		});
	});

	test("posts both rails to unified checkout and carries the exact wallet quote", () => {
		expect(subscriptionCreateRequest(createRequest())).toEqual({
			idempotencyKey: "subscription-create-test",
			body: {
				plan_slug: "compute_performance",
				billing_term_months: 12,
				funding_source: "wallet",
				ui_mode: "custom",
				deploy_config: deployConfig,
				quote: walletQuote,
			},
		});

		expect(
			subscriptionCreateRequest(
				createRequest({
					selection: {
						planSlug: "compute_basic",
						billingTermMonths: 1,
						fundingSource: "stripe",
					},
					target: { kind: "terminal_fallback", deploymentId: "hdep_fallback" },
					quote: null,
				}),
			),
		).toEqual({
			idempotencyKey: "subscription-create-test",
			body: {
				plan_slug: "compute_basic",
				billing_term_months: 1,
				funding_source: "stripe",
				ui_mode: "custom",
				upgrade_deployment_id: "hdep_fallback",
			},
		});
	});

	test("normalizes unified wallet activation results", () => {
		const activation: CheckoutResult = {
			flow_type: "subscription_activation",
			funding_source: "wallet",
			checkout_url: "",
			subscription_id: 42,
			invoice_id: "in_42",
			deploy_request_id: "subscription-create-test",
			deployment_id: "hdep_created",
			debited_credits: "180000",
			balance_after_credits: "20000.25",
			current_period_start: "2026-07-16T00:00:00Z",
			current_period_end: "2027-07-16T00:00:00Z",
			entitled_until: "2027-07-16T00:00:00Z",
		};
		expect(subscriptionCreateOutcome(activation)).toMatchObject({
			flowType: "subscription_activation",
			subscriptionId: 42,
			invoiceId: "in_42",
			deploymentId: "hdep_created",
			exactDebitCredits: "180000",
			balanceAfterCredits: "20000.25",
		});
	});
});
