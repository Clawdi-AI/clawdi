import { describe, expect, test } from "bun:test";
import {
	creditPrice,
	formatCreditCents,
	formatCredits,
	purchaseErrorNotice,
	purchaseOutcomeNotice,
	signedCredits,
} from "./store-presentation";

describe("credit units", () => {
	test("never render a dollar sign", () => {
		expect(formatCredits("1234.5", "credits")).toBe("1,234.50 credits");
		expect(formatCredits("-3.004", "credits")).toBe("-3.00 credits");
		expect(formatCredits("0.001", "credits")).toBe("<0.01 credits");
		expect(formatCredits("invalid", "credits")).toBe("—");
		expect(formatCreditCents(2500, "credits")).toBe("25.00 credits");
		expect(signedCredits("−$25.00", "credits")).toBe("−25.00 credits");
	});

	test("only USD prices have a credit equivalent", () => {
		expect(creditPrice({ price_cents: 999, currency: "USD" }, "credits")).toBe("9.99 credits");
		expect(creditPrice({ price_cents: 999, currency: "eur" }, "credits")).toBeNull();
		expect(creditPrice({ price_cents: null, currency: "usd" }, "credits")).toBeNull();
	});
});

describe("purchase notices", () => {
	const outcome = (
		status: Parameters<typeof purchaseOutcomeNotice>[0]["status"],
		state = "prepared",
	) => ({ status, attempt: { state } }) as Parameters<typeof purchaseOutcomeNotice>[0];

	test("funded and submitted purchases refresh the Wallet balance", () => {
		expect(purchaseOutcomeNotice(outcome("funding_applied", "funding_applied"), null)).toEqual({
			key: "store.fundingApplied",
			tone: "success",
			refresh: true,
		});
		expect(purchaseOutcomeNotice(outcome("submitted", "expired"), null)).toMatchObject({
			key: "store.submitted",
			refresh: true,
		});
	});

	test("dismissal is silent unless the Paywall itself was unavailable", () => {
		expect(purchaseOutcomeNotice(outcome("cancelled"), null)).toBeNull();
		expect(purchaseOutcomeNotice(outcome("cancelled"), "paywall_unavailable")).toMatchObject({
			key: "store.paywallUnavailable",
		});
	});

	test("a reconciliation hold asks for review instead of another purchase", () => {
		expect(
			purchaseOutcomeNotice(outcome("terminal", "reconciliation_required"), null),
		).toMatchObject({ key: "store.reviewRequired" });
	});

	test("deferred and uncertain purchases are never shown as failures to retry blindly", () => {
		expect(purchaseErrorNotice("payment_pending").key).toBe("store.paymentPending");
		for (const code of ["purchase_unconfirmed", "store_operation_timeout"] as const)
			expect(purchaseErrorNotice(code)).toMatchObject({ key: "store.unconfirmed", refresh: true });
		expect(purchaseErrorNotice("purchase_pending").key).toBe("store.purchaseInProgress");
		expect(purchaseErrorNotice("store_purchases_disabled").key).toBe("store.unavailable");
	});
});
