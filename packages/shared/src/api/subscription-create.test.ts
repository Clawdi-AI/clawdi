import { describe, expect, test } from "bun:test";
import {
	hostedCheckoutSends,
	hostedSubscriptionActivationTarget,
	hostedSubscriptionQuoteWalletDebit,
	hostedWalletFundingErrorKind,
	recordHostedCheckoutSends,
	sameHostedSubscriptionQuoteTerms,
} from "./subscription-create";

const quote = {
	plan_slug: "compute_basic",
	billing_term_months: 1,
	funding_source: "wallet",
	currency: "usd",
	term_price_cents: 1000,
	expires_at: "2026-10-09T00:15:00Z",
	debit_amount_usd: "10.00",
	balance_before_usd: "4.00",
	balance_after_usd: "-6.00",
} as const;

describe("subscription creation contract", () => {
	test("a Wallet quote exposes its exact debit, including a shortfall", () => {
		expect(hostedSubscriptionQuoteWalletDebit(quote)).toEqual({
			balanceBeforeUsd: "4.00",
			debitAmountUsd: "10.00",
			balanceAfterUsd: "-6.00",
		});
		expect(hostedSubscriptionQuoteWalletDebit({ ...quote, funding_source: "stripe" })).toBeNull();
		expect(() => hostedSubscriptionQuoteWalletDebit({ ...quote, debit_amount_usd: " " })).toThrow(
			"exact wallet debit",
		);
	});

	test("quote terms compare like hosted's confirmation check", () => {
		const refreshed = {
			...quote,
			expires_at: "2026-10-09T00:30:00Z",
			preview_invoice_id: "upcoming_in_2",
			debit_amount_usd: "10.0",
		};
		expect(sameHostedSubscriptionQuoteTerms(quote, refreshed)).toBe(true);
		expect(
			sameHostedSubscriptionQuoteTerms(quote, {
				...refreshed,
				balance_before_usd: "14.00",
				balance_after_usd: "4.00",
			}),
		).toBe(false);
		expect(sameHostedSubscriptionQuoteTerms(quote, { ...quote, billing_term_months: 12 })).toBe(
			false,
		);
	});

	test("an activation resolves its accepted deployment before its durable request", () => {
		expect(
			hostedSubscriptionActivationTarget({ deployment_id: " hdep_a ", deploy_request_id: "r" }),
		).toEqual({ kind: "deployment", deploymentId: "hdep_a" });
		expect(
			hostedSubscriptionActivationTarget({ deployment_id: null, deploy_request_id: "r" }),
		).toEqual({ kind: "deploy_request", deployRequestId: "r" });
		expect(() =>
			hostedSubscriptionActivationTarget({ deployment_id: "", deploy_request_id: null }),
		).toThrow();
	});

	test("only structured Wallet funding codes ask for a top-up", () => {
		expect(hostedWalletFundingErrorKind("insufficient_wallet_balance")).toBe(
			"insufficient_balance",
		);
		expect(hostedWalletFundingErrorKind("insufficient_balance")).toBe("insufficient_balance");
		expect(hostedWalletFundingErrorKind("open_refund_debt")).toBe("open_refund_debt");
		expect(hostedWalletFundingErrorKind("idempotency_key_reused")).toBe("other");
		expect(hostedWalletFundingErrorKind(null)).toBe("other");
	});

	test("an unrecorded checkout send count is unknown, never a first send", () => {
		expect(hostedCheckoutSends(new Error("thrown before the shared retry"))).toBeNull();
		expect(hostedCheckoutSends(null)).toBeNull();
		expect(hostedCheckoutSends("refused")).toBeNull();
		expect(hostedCheckoutSends(recordHostedCheckoutSends(new Error("refused"), 1))).toBe(1);
		expect(hostedCheckoutSends(recordHostedCheckoutSends(new Error("refused"), 3))).toBe(3);
	});
});
