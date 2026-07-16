import { describe, expect, test } from "bun:test";
import type { WalletComputeQuoteResponse } from "@/hosted/billing/contracts";
import {
	walletDebitShortfallCredits,
	walletSubscriptionDebitSummary,
} from "./wallet-debit-summary";

function quote(overrides: Partial<WalletComputeQuoteResponse> = {}): WalletComputeQuoteResponse {
	return {
		plan_slug: "compute_performance",
		billing_term_months: 12,
		monthly_price_cents: 1_900,
		monthly_price_credits: "19000",
		points_per_usd: 1_000,
		first_charge_cents: 18_000,
		first_charge_credits: "180000",
		period_start: "2026-07-16T00:00:00Z",
		period_end: "2027-07-16T00:00:00Z",
		balance_credits: "200000.25",
		post_charge_balance_estimate_credits: "20000.25",
		warnings: [],
		...overrides,
	};
}

describe("walletSubscriptionDebitSummary", () => {
	test("maps generated annual quote fields to rail-neutral debit semantics", () => {
		expect(walletSubscriptionDebitSummary(quote())).toEqual({
			balanceBeforeCredits: "200000.25",
			exactDebitCredits: "180000",
			exactDebitCents: 18_000,
			balanceAfterCredits: "20000.25",
			pointsPerUsd: 1_000,
			hasOpenRefundDebt: false,
			hasLowCoverage: false,
		});
	});

	test("derives shortfall and warnings from the mapped summary", () => {
		const summary = walletSubscriptionDebitSummary(
			quote({
				post_charge_balance_estimate_credits: "-1250.5",
				warnings: ["open_refund_debt", "low_coverage"],
			}),
		);
		expect(walletDebitShortfallCredits(summary)).toBe(1250.5);
		expect(summary.hasOpenRefundDebt).toBe(true);
		expect(summary.hasLowCoverage).toBe(true);
	});
});
