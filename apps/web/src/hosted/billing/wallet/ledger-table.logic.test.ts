import { describe, expect, test } from "bun:test";
import type { WalletLedgerEntry } from "@/hosted/billing/contracts";
import {
	filteredLedgerEntries,
	ledgerEmptyStateCopy,
	ledgerOperationGroup,
} from "./ledger-table.logic";

function entry(overrides: Partial<WalletLedgerEntry> = {}): WalletLedgerEntry {
	return {
		id: "entry_1",
		operation: "topup",
		request_id: "request_1",
		credits_amount: 1000,
		status: "applied",
		notes: null,
		created_at: "2026-07-01T00:00:00Z",
		applied_at: "2026-07-01T00:00:00Z",
		...overrides,
	};
}

describe("filteredLedgerEntries", () => {
	test("can return an empty filtered page while older pages may still match", () => {
		const filtered = filteredLedgerEntries([entry({ operation: "topup" })], "refund");

		expect(filtered).toEqual([]);
	});

	test("groups compute charges and reversals under Compute", () => {
		expect(ledgerOperationGroup("compute_charge")).toBe("compute");
		expect(ledgerOperationGroup("compute_credit")).toBe("compute");
		expect(
			filteredLedgerEntries(
				[entry({ operation: "compute_charge" }), entry({ id: "entry_2", operation: "topup" })],
				"compute",
			).map((item) => item.operation),
		).toEqual(["compute_charge"]);
	});
});

describe("ledgerEmptyStateCopy", () => {
	test("prompts the user to load more when the current filtered page is empty", () => {
		expect(ledgerEmptyStateCopy({ entriesCount: 1, filter: "refund", canLoadMore: true })).toEqual({
			title: "No matching activity on this page",
			description: "Load more to search older activity.",
		});
	});

	test("uses the terminal no-match copy only when there is nothing more to load", () => {
		expect(ledgerEmptyStateCopy({ entriesCount: 1, filter: "refund", canLoadMore: false })).toEqual(
			{
				title: "No matching activity",
				description: "Change the filter to see other wallet entries.",
			},
		);
	});

	test("keeps the empty-wallet copy for wallets with no loaded entries", () => {
		expect(ledgerEmptyStateCopy({ entriesCount: 0, filter: "all", canLoadMore: false })).toEqual({
			title: "No activity yet",
			description: "Top-ups, grants, and usage will show up here.",
		});
	});
});
