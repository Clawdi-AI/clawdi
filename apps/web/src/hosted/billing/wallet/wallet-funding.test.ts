import { describe, expect, test } from "bun:test";
import { BillingApiError } from "@/hosted/billing/errors";
import { classifyWalletFundingError, decimalUsd } from "@/hosted/billing/wallet/wallet-funding";

function billingError(detail: Record<string, unknown>): BillingApiError {
	return new BillingApiError(409, JSON.stringify({ detail }), { detail });
}

describe("classifyWalletFundingError", () => {
	test("normalizes both insufficient-balance codes and their USD shortfall", () => {
		for (const code of ["insufficient_wallet_balance", "insufficient_balance"]) {
			expect(
				classifyWalletFundingError(
					billingError({ code, shortfall_usd: code === "insufficient_balance" ? 12.5 : "12.50" }),
				),
			).toEqual({ kind: "insufficient_balance", shortfallUsd: 12.5 });
		}
	});

	test("classifies refund debt without inventing a shortfall", () => {
		expect(classifyWalletFundingError(billingError({ code: "open_refund_debt" }))).toEqual({
			kind: "open_refund_debt",
			shortfallUsd: null,
		});
	});

	test("leaves unrelated and malformed errors unclassified", () => {
		expect(classifyWalletFundingError(new Error("offline"))).toEqual({
			kind: "other",
			shortfallUsd: null,
		});
		expect(
			classifyWalletFundingError(
				billingError({ code: "insufficient_balance", shortfall_usd: "-1" }),
			),
		).toEqual({ kind: "insufficient_balance", shortfallUsd: null });
	});
});

describe("decimalUsd", () => {
	test("accepts finite non-negative decimal strings and numbers only", () => {
		expect(decimalUsd("25.01")).toBe(25.01);
		expect(decimalUsd(0)).toBe(0);
		expect(decimalUsd(-1)).toBeNull();
		expect(decimalUsd(Number.NaN)).toBeNull();
		expect(decimalUsd(null)).toBeNull();
	});
});
