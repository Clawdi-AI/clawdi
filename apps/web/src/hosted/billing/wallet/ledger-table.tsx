"use client";

import { ExternalLink, Receipt } from "lucide-react";
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
import { Separator } from "@/components/ui/separator";
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
	applied: "Completed",
	pending: "Pending",
	failed: "Failed",
};
const LEDGER_FILTER_ITEMS = [
	{ value: "all", label: "All activity" },
	{ value: "topup", label: "Top-ups" },
	{ value: "grant", label: "Grants" },
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

function ledgerEntryKey(entry: WalletLedgerEntry): string {
	return `${entry.created_at}:${entry.operation}:${entry.amount_usd}`;
}

function ReceiptLink({ entry }: { entry: WalletLedgerEntry }) {
	if (!entry.receipt_url) return null;
	return (
		<Button
			render={<a href={entry.receipt_url} target="_blank" rel="noopener noreferrer" />}
			nativeButton={false}
			variant="link"
			size="xs"
			className="h-auto px-0"
		>
			Receipt <ExternalLink data-icon="inline-end" />
		</Button>
	);
}

export function LedgerTable({
	entries,
	isLoading = false,
	hasMore = false,
	isFetchingMore = false,
	onShowMore,
}: {
	entries: WalletLedgerEntry[];
	isLoading?: boolean;
	/** More entries likely exist beyond the current window. */
	hasMore?: boolean;
	isFetchingMore?: boolean;
	onShowMore?: () => void;
}) {
	const [filter, setFilter] = useState<LedgerFilter>("all");
	const headingId = useId();

	const filtered = useMemo(() => filteredLedgerEntries(entries, filter), [entries, filter]);
	const canLoadMore = hasMore && onShowMore != null;
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
						"Load more"
					)}
				</Button>
			</div>
		);
	}

	return (
		<section data-hosted="true" className="flex flex-col gap-4" aria-labelledby={headingId}>
			<Separator />
			<div className="flex items-center justify-between gap-2">
				<h2 id={headingId} className="text-sm font-semibold">
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
								<li
									key={ledgerEntryKey(entry)}
									className="flex items-start justify-between gap-3 p-3"
								>
									<div className="min-w-0 space-y-1">
										<div className="font-medium">{ledgerOperationLabel(entry.operation)}</div>
										<div className="truncate text-xs text-muted-foreground">
											{entry.description}
										</div>
										<div className="flex items-center gap-2">
											<StatusBadge status={statusVariant(entry.status)}>
												{statusLabel(entry.status)}
											</StatusBadge>
											<span className="text-xs text-muted-foreground">
												{relativeTime(entry.created_at)}
											</span>
										</div>
										<ReceiptLink entry={entry} />
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
									<TableHead className="text-right">Receipt</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{filtered.map((entry) => {
									const positive = amountIsPositive(entry);
									return (
										<TableRow key={ledgerEntryKey(entry)}>
											<TableCell>
												<div className="font-medium">{ledgerOperationLabel(entry.operation)}</div>
												<div className="max-w-[18rem] truncate text-xs text-muted-foreground">
													{entry.description}
												</div>
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
											<TableCell className="text-right">
												<ReceiptLink entry={entry} />
											</TableCell>
										</TableRow>
									);
								})}
							</TableBody>
						</Table>
					</div>

					{renderLoadMoreControl()}
				</>
			)}
		</section>
	);
}
