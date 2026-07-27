import type { WalletLedgerEntry } from "@/hosted/billing/contracts";

export type LedgerFilter = "all" | "topup" | "grant" | "compute" | "refund";

const LEDGER_FILTERS: readonly LedgerFilter[] = ["all", "topup", "grant", "compute", "refund"];

const LEDGER_OPERATION_LABELS: Record<string, string> = {
	topup: "Top-up",
	x402: "On-chain top-up",
	grant_signup: "Signup grant",
	admin_adjust: "Adjustment",
	compute_charge: "Compute charge",
	compute_credit: "Compute reversal",
	refund: "Refund",
};

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
	if (op === "topup" || op === "x402") return "topup";
	if (op === "grant_signup") return "grant";
	if (op === "compute_charge" || op === "compute_credit") return "compute";
	if (op === "refund") return "refund";
	return "all";
}

export function ledgerOperationLabel(op: string): string {
	return LEDGER_OPERATION_LABELS[op] ?? "Other activity";
}

export function filteredLedgerEntries(
	entries: WalletLedgerEntry[],
	filter: LedgerFilter,
): WalletLedgerEntry[] {
	return filter === "all"
		? entries
		: entries.filter((entry) => ledgerOperationGroup(entry.operation) === filter);
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
