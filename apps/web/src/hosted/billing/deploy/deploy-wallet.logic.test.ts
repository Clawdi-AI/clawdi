import { describe, expect, test } from "bun:test";
import { BillingApiError, BillingNetworkError } from "@/hosted/billing/errors";
import { walletActivationFailure, walletPaymentDisabledReason } from "./deploy-wallet.logic";

describe("walletActivationFailure", () => {
	test("extracts the 402 shortfall", () => {
		const error = new BillingApiError(402, "insufficient", {
			detail: {
				code: "insufficient_wallet_balance",
				shortfall_credits: "14000.5000",
			},
		});
		expect(walletActivationFailure(error)).toMatchObject({
			kind: "insufficient",
			code: "insufficient_wallet_balance",
			shortfallCredits: 14_000.5,
		});
	});

	test("separates conflicts from retryable ambiguous failures", () => {
		expect(
			walletActivationFailure(
				new BillingApiError(409, "conflict", { detail: { code: "open_refund_debt" } }),
			).kind,
		).toBe("conflict");
		expect(
			walletActivationFailure(
				new BillingApiError(502, "upstream", {
					detail: { code: "wallet_compute_upstream_failed", retryable: true },
				}),
			).kind,
		).toBe("retryable");
		expect(walletActivationFailure(new BillingNetworkError("offline")).kind).toBe("retryable");
	});
});

describe("walletPaymentDisabledReason", () => {
	test("keeps wallet visible but unavailable for annual terms", () => {
		expect(walletPaymentDisabledReason(1)).toBeNull();
		expect(walletPaymentDisabledReason(12)).toContain("renews monthly");
	});
});
