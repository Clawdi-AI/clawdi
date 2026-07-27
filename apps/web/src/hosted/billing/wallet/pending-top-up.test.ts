import { describe, expect, test } from "bun:test";
import type { WalletLedgerEntry } from "@/hosted/billing/contracts";
import {
	clearPendingTopUpCredit,
	PENDING_TOP_UP_STORAGE_KEY,
	type PendingTopUpCredit,
	pendingTopUpCreditIsApplied,
	readPendingTopUpCredit,
	writePendingTopUpCredit,
} from "@/hosted/billing/wallet/pending-top-up";

const pending: PendingTopUpCredit = {
	providerStatus: "succeeded",
	amountCents: 1_000,
	paymentStartedAtMs: Date.parse("2026-07-27T06:00:00Z"),
	checkStartedAtMs: Date.parse("2026-07-27T06:00:02Z"),
};

function ledgerEntry(overrides: Partial<WalletLedgerEntry> = {}): WalletLedgerEntry {
	return {
		operation: "topup",
		description: "Card top-up",
		amount_usd: "10.00",
		status: "applied",
		receipt_url: null,
		created_at: "2026-07-27T06:00:01Z",
		applied_at: "2026-07-27T06:00:03Z",
		...overrides,
	};
}

describe("pending Wallet top-up marker", () => {
	test("persists only non-sensitive confirmation context across a reload", () => {
		const values = new Map<string, string>();
		const storage = {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => values.set(key, value),
			removeItem: (key: string) => values.delete(key),
		};

		writePendingTopUpCredit(storage, pending);

		expect(readPendingTopUpCredit(storage)).toEqual(pending);
		expect(values.get(PENDING_TOP_UP_STORAGE_KEY)).not.toContain("client_secret");
		expect(values.get(PENDING_TOP_UP_STORAGE_KEY)).not.toContain("payment_intent");
		clearPendingTopUpCredit(storage);
		expect(readPendingTopUpCredit(storage)).toBeNull();
	});

	test("rejects malformed stored state at the browser boundary", () => {
		expect(
			readPendingTopUpCredit({
				getItem: () => JSON.stringify({ ...pending, amountCents: "1000" }),
			}),
		).toBeNull();
		expect(readPendingTopUpCredit({ getItem: () => "not-json" })).toBeNull();
	});
});

describe("pendingTopUpCreditIsApplied", () => {
	test("requires a matching applied Stripe top-up after the payment began", () => {
		expect(pendingTopUpCreditIsApplied(pending, [ledgerEntry()])).toBe(true);
		expect(pendingTopUpCreditIsApplied(pending, [ledgerEntry({ status: "pending" })])).toBe(false);
		expect(pendingTopUpCreditIsApplied(pending, [ledgerEntry({ amount_usd: "25.00" })])).toBe(
			false,
		);
		expect(
			pendingTopUpCreditIsApplied(pending, [ledgerEntry({ created_at: "2026-07-27T05:58:00Z" })]),
		).toBe(false);
		expect(pendingTopUpCreditIsApplied(pending, [ledgerEntry({ operation: "x402" })])).toBe(false);
	});
});
