"use client";

import { Receipt } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { StatusBadge } from "@/components/ui/status-badge";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import type { WalletLedgerEntry, WalletLedgerStatus } from "@/hosted/billing/contracts";
import { formatUsdExact } from "@/hosted/billing/format";
import {
	filteredLedgerEntries,
	isLedgerFilter,
	type LedgerFilter,
	ledgerEmptyStateCopy,
	ledgerOperationLabel,
} from "@/hosted/billing/wallet/ledger-table.logic";
import { cn, relativeTime } from "@/lib/utils";

const STATUS_LABELS: Record<WalletLedgerStatus, string> = {
	applied: "Applied",
	pending: "Pending",
	failed: "Failed",
};
const LEDGER_FILTER_ITEMS = [
	{ value: "all", label: "All activity" },
	{ value: "topup", label: "Top-ups" },
	{ value: "grant", label: "Grants" },
	{ value: "usage", label: "Usage" },
	{ value: "compute", label: "Compute" },
	{ value: "refund", label: "Refunds" },
] as const;

function statusVariant(
	status: WalletLedgerStatus,
): "success" | "warning" | "destructive" | "neutral" {
	if (status === "applied") return "success";
	if (status === "pending") return "warning";
	if (status === "failed") return "destructive";
	return "neutral";
}

function opLabel(op: string): string {
	return ledgerOperationLabel(op);
}
function statusLabel(status: WalletLedgerStatus): string {
	return STATUS_LABELS[status] ?? "Unknown";
}
function amountIsPositive(entry: WalletLedgerEntry): boolean {
	return !entry.amount_usd.trim().startsWith("-");
}

function signedAmount(entry: WalletLedgerEntry): string {
	const positive = amountIsPositive(entry);
	const unsignedAmount = entry.amount_usd.trim().replace(/^[+-]/, "");
	return `${positive ? "+" : "−"}${formatUsdExact(unsignedAmount)}`;
}

export function LedgerTable({
	entries,
	isLoading = false,
	hasMore = false,
	atCap = false,
	isFetchingMore = false,
	onShowMore,
}: {
	entries: WalletLedgerEntry[];
	isLoading?: boolean;
	/** More entries likely exist beyond the current window. */
	hasMore?: boolean;
	/** The client-side row cap is reached — stop offering "Show more". */
	atCap?: boolean;
	isFetchingMore?: boolean;
	onShowMore?: () => void;
}) {
	const [filter, setFilter] = useState<LedgerFilter>("all");
	const headingId = useId();

	const filtered = useMemo(() => filteredLedgerEntries(entries, filter), [entries, filter]);
	const canLoadMore = !atCap && hasMore && onShowMore != null;
	const emptyState = ledgerEmptyStateCopy({ entriesCount: entries.length, filter, canLoadMore });

	function handleFilterChange(value: string) {
		if (isLedgerFilter(value)) {
			setFilter(value);
		}
	}

	function renderLoadMoreControl() {
		if (!canLoadMore || !onShowMore) return null;

		return (
			<div className="flex justify-center">
				<Button size="sm" variant="outline" onClick={onShowMore} disabled={isFetchingMore}>
					{isFetchingMore ? (
						<>
							<Spinner /> Loading…
						</>
					) : (
						"Show more"
					)}
				</Button>
			</div>
		);
	}

	return (
		<section data-hosted="true" className="space-y-3" aria-labelledby={headingId}>
			<div className="flex items-center justify-between gap-2">
				<h2 id={headingId} className="text-base font-semibold">
					Activity
				</h2>
				<Select
					items={LEDGER_FILTER_ITEMS}
					value={filter}
					onValueChange={(value) => {
						if (value !== null) handleFilterChange(value);
					}}
				>
					<SelectTrigger size="sm" className="w-40" aria-label="Filter activity">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{LEDGER_FILTER_ITEMS.map((item) => (
							<SelectItem key={item.value} value={item.value}>
								{item.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>

			{isLoading ? (
				<div className="space-y-px overflow-hidden rounded-lg border">
					{Array.from({ length: 5 }, (_, i) => `s-${i}`).map((key) => (
						<div key={key} className="flex items-center justify-between gap-4 px-3 py-3">
							<Skeleton className="h-4 w-40" />
							<Skeleton className="h-4 w-16" />
						</div>
					))}
				</div>
			) : filtered.length === 0 ? (
				<>
					<EmptyState
						variant="inset"
						icon={Receipt}
						title={emptyState.title}
						description={emptyState.description}
					/>
					{renderLoadMoreControl()}
				</>
			) : (
				<>
					{/* Mobile: a stacked list — a 4-column table would clip on narrow
					    viewports. sm+ gets the full table. */}
					<ul className="divide-y overflow-hidden rounded-lg border sm:hidden">
						{filtered.map((entry) => {
							const positive = amountIsPositive(entry);
							return (
								<li key={entry.id} className="flex items-start justify-between gap-3 p-3">
									<div className="min-w-0 space-y-1">
										<div className="font-medium">{opLabel(entry.operation)}</div>
										{entry.notes ? (
											<div className="truncate text-xs text-muted-foreground">{entry.notes}</div>
										) : null}
										<div className="flex items-center gap-2">
											<StatusBadge status={statusVariant(entry.status)}>
												{statusLabel(entry.status)}
											</StatusBadge>
											<span className="text-xs text-muted-foreground">
												{relativeTime(entry.created_at)}
											</span>
										</div>
									</div>
									<span
										className={cn(
											"shrink-0 font-medium tabular-nums",
											positive ? "text-success-muted-foreground" : "text-foreground",
										)}
									>
										{signedAmount(entry)}
									</span>
								</li>
							);
						})}
					</ul>

					<div className="hidden overflow-hidden rounded-lg border sm:block">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Type</TableHead>
									<TableHead>Status</TableHead>
									<TableHead className="text-right">Amount</TableHead>
									<TableHead className="text-right">When</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{filtered.map((entry) => {
									const positive = amountIsPositive(entry);
									return (
										<TableRow key={entry.id}>
											<TableCell>
												<div className="font-medium">{opLabel(entry.operation)}</div>
												{entry.notes ? (
													<div className="max-w-[18rem] truncate text-xs text-muted-foreground">
														{entry.notes}
													</div>
												) : null}
											</TableCell>
											<TableCell>
												<StatusBadge status={statusVariant(entry.status)}>
													{statusLabel(entry.status)}
												</StatusBadge>
											</TableCell>
											<TableCell
												className={cn(
													"text-right font-medium tabular-nums",
													positive ? "text-success-muted-foreground" : "text-foreground",
												)}
											>
												{signedAmount(entry)}
											</TableCell>
											<TableCell className="whitespace-nowrap text-right text-sm text-muted-foreground">
												{relativeTime(entry.created_at)}
											</TableCell>
										</TableRow>
									);
								})}
							</TableBody>
						</Table>
					</div>

					{atCap ? (
						<p className="text-center text-xs text-muted-foreground">
							Showing your most recent activity. Older entries are archived.
						</p>
					) : (
						renderLoadMoreControl()
					)}
				</>
			)}
		</section>
	);
}
