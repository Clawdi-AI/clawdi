import { describe, expect, test } from "bun:test";
import type { ComputeBillingHistoryItem } from "@/hosted/billing/contracts";
import { billingHistoryFundingLabel, visibleBillingHistoryRows } from "./billing-history.logic";

function invoice(overrides: Partial<ComputeBillingHistoryItem> = {}): ComputeBillingHistoryItem {
	return {
		id: "in_123",
		funding_source: "stripe",
		compute_subscription_id: 42,
		plan_slug: "compute_performance",
		status: "paid",
		amount_cents: 1_900,
		currency: "usd",
		created: "2026-07-16T00:00:00Z",
		stripe_invoice_id: "in_123",
		stripe_invoice_number: "CLAWDI-123",
		hosted_invoice_url: "https://invoice.stripe.test/in_123",
		...overrides,
	};
}

describe("visibleBillingHistoryRows", () => {
	test("keeps non-zero Stripe invoices for card and wallet", () => {
		const card = invoice();
		const wallet = invoice({ id: "in_wallet", funding_source: "wallet" });
		expect(visibleBillingHistoryRows([card, wallet])).toEqual([card, wallet]);
	});

	test("hides free invoices and legacy wallet-charge rows", () => {
		expect(
			visibleBillingHistoryRows([
				invoice({ id: "in_free", amount_cents: 0 }),
				invoice({ id: "wallet_charge_1", funding_source: "wallet", stripe_invoice_id: null }),
			]),
		).toEqual([]);
	});
});

describe("billingHistoryFundingLabel", () => {
	test("names the wallet settlement without hiding the Stripe invoice", () => {
		expect(billingHistoryFundingLabel("wallet")).toBe("Paid with AI Credits");
		expect(billingHistoryFundingLabel("stripe")).toBe("Paid by card");
	});
});
