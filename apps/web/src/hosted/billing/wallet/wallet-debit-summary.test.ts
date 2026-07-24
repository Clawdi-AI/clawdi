import { describe, expect, test } from "bun:test";
import { type WalletDebitSummary, walletDebitShortfallUsd } from "./wallet-debit-summary";

function summary(overrides: Partial<WalletDebitSummary> = {}): WalletDebitSummary {
	return {
		balanceBeforeUsd: "200.00025",
		debitAmountUsd: "180",
		balanceAfterUsd: "20.00025",
		...overrides,
	};
}

describe("walletDebitShortfallUsd", () => {
	test("derives an exact decimal shortfall from the presentation model", () => {
		expect(walletDebitShortfallUsd(summary({ balanceAfterUsd: "-1.2505" }))).toBe(1.2505);
		expect(walletDebitShortfallUsd(summary())).toBeNull();
	});
});
