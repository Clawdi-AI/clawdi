import { describe, expect, test } from "bun:test";
import { type WalletDebitSummary, walletDebitShortfallCredits } from "./wallet-debit-summary";

function summary(overrides: Partial<WalletDebitSummary> = {}): WalletDebitSummary {
	return {
		balanceBeforeCredits: "200000.25",
		exactDebitCredits: "180000",
		exactDebitCents: 18_000,
		balanceAfterCredits: "20000.25",
		pointsPerUsd: 1_000,
		...overrides,
	};
}

describe("walletDebitShortfallCredits", () => {
	test("derives an exact decimal shortfall from the presentation model", () => {
		expect(walletDebitShortfallCredits(summary({ balanceAfterCredits: "-1250.5" }))).toBe(1250.5);
		expect(walletDebitShortfallCredits(summary())).toBeNull();
	});
});
