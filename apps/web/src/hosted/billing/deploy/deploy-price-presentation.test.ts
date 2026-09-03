import { describe, expect, test } from "bun:test";
import type { BillingOffer } from "@/hosted/billing/contracts";
import {
	cardDeployAmountPresentation,
	cardTrialPricePresentation,
	computePricePresentation,
	walletDeployAmountPresentation,
} from "@/hosted/billing/deploy/deploy-price-presentation";

const monthly: BillingOffer = {
	billing_term_months: 1,
	price_cents: 2_000,
	effective_monthly_price_cents: 2_000,
	discount_percent: 0,
	card_trial_period_days: 7,
};
const annual: BillingOffer = {
	billing_term_months: 12,
	price_cents: 20_000,
	effective_monthly_price_cents: 1_666,
	discount_percent: 17,
	card_trial_period_days: 7,
};

describe("computePricePresentation", () => {
	test("makes monthly and annual pricing visibly distinct", () => {
		expect(computePricePresentation(monthly, [monthly, annual])).toEqual({
			primary: "$20.00/mo",
			secondary: "Billed monthly",
			savings: null,
			trial: { badge: "7 days free", afterTrial: "Then $20.00/mo" },
		});
		expect(computePricePresentation(annual, [monthly, annual])).toEqual({
			primary: "$200.00/yr",
			secondary: "$16.66/mo",
			savings: "save $40.00",
			trial: { badge: "7 days free", afterTrial: "Then $200.00/yr" },
		});
	});

	test("omits savings when a monthly offer is missing", () => {
		expect(computePricePresentation(annual, [annual])).toEqual({
			primary: "$200.00/yr",
			secondary: "$16.66/mo",
			savings: null,
			trial: { badge: "7 days free", afterTrial: "Then $200.00/yr" },
		});
	});
});

describe("CTA-adjacent amount presentation", () => {
	test("uses only a positive Stripe trial period", () => {
		expect(cardTrialPricePresentation("$20.00/mo", 1)).toEqual({
			badge: "1 day free",
			afterTrial: "Then $20.00/mo",
		});
		expect(cardTrialPricePresentation("$20.00/mo", null)).toBeNull();
		expect(cardTrialPricePresentation("$20.00/mo", 0)).toBeNull();
	});

	test("uses term price for card checkout and authoritative debit for Wallet", () => {
		expect(cardDeployAmountPresentation(monthly)).toEqual({
			amount: "$20.00/mo",
			badge: "7 days free",
			caption: "Then $20.00/mo",
			detail: null,
		});
		expect(cardDeployAmountPresentation(annual)).toEqual({
			amount: "$200.00/yr",
			badge: "7 days free",
			caption: "Then $200.00/yr · $16.66/mo",
			detail: null,
		});
		expect(cardDeployAmountPresentation({ ...monthly, card_trial_period_days: null })).toEqual({
			amount: "$20.00/mo",
			badge: null,
			caption: "Billed monthly",
			detail: null,
		});
		expect(
			walletDeployAmountPresentation({
				billingTermMonths: 12,
				state: "ready",
				walletDebit: {
					balanceBeforeUsd: "100.00",
					debitAmountUsd: "100.00",
					balanceAfterUsd: "0.00",
				},
			}),
		).toEqual({
			amount: "Debit today: $100.00",
			badge: null,
			caption: "From Wallet · renews yearly",
			detail: null,
		});
	});

	test("covers loading, error, and insufficient Wallet states without inventing a debit", () => {
		expect(
			walletDeployAmountPresentation({
				billingTermMonths: 1,
				state: "loading",
				walletDebit: null,
			}),
		).toEqual({ amount: "Debit today: —", badge: null, caption: "Getting quote…", detail: null });
		expect(
			walletDeployAmountPresentation({
				billingTermMonths: 1,
				state: "error",
				walletDebit: null,
			}),
		).toEqual({ amount: "Quote unavailable", badge: null, caption: null, detail: null });
		expect(
			walletDeployAmountPresentation({
				billingTermMonths: 1,
				state: "ready",
				walletDebit: {
					balanceBeforeUsd: "12.50",
					debitAmountUsd: "20.00",
					balanceAfterUsd: "-7.50",
				},
			}),
		).toEqual({
			amount: "Debit today: $20.00",
			badge: null,
			caption: "From Wallet · renews monthly",
			detail: "Available $12.50 · short $7.50",
		});
	});
});
