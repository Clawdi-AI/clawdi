import type { WalletLedgerEntry } from "@/hosted/billing/contracts";

export type LedgerFilter = "all" | "topup" | "grant" | "usage" | "refund";

const LEDGER_FILTERS: readonly LedgerFilter[] = ["all", "topup", "grant", "usage", "refund"];

export interface LedgerEmptyStateCopyInput {
	entriesCount: number;
	filter: LedgerFilter;
	canLoadMore: boolean;
}

export interface LedgerEmptyStateCopy {
	title: string;
	description: string;
}

export function isLedgerFilter(value: string): value is LedgerFilter {
	return LEDGER_FILTERS.some((filter) => filter === value);
}

export function ledgerOperationGroup(op: string): LedgerFilter {
	if (op === "topup" || op === "invoice" || op === "x402") return "topup";
	if (op.startsWith("grant_")) return "grant";
	if (op === "proxy") return "usage";
	if (op === "refund") return "refund";
	return "all";
}

export function filteredLedgerEntries(
	entries: WalletLedgerEntry[],
	filter: LedgerFilter,
): WalletLedgerEntry[] {
	return (
		filter === "all"
			? entries
			: entries.filter((entry) => ledgerOperationGroup(entry.operation) === filter)
	).filter(
		// Defensive: skip malformed rows (missing id) rather than emit a
		// React key warning or render an "undefined" row.
		(entry): entry is WalletLedgerEntry => entry != null && typeof entry.id === "string",
	);
}

export function ledgerEmptyStateCopy({
	entriesCount,
	filter,
	canLoadMore,
}: LedgerEmptyStateCopyInput): LedgerEmptyStateCopy {
	if (canLoadMore) {
		return {
			title: filter === "all" ? "No activity on this page" : "No matching activity on this page",
			description: "Load more to search older activity.",
		};
	}

	if (entriesCount === 0) {
		return {
			title: "No activity yet",
			description: "Top-ups, grants, and usage will show up here.",
		};
	}

	return {
		title: "No matching activity",
		description: "Change the filter to see other wallet entries.",
	};
}
