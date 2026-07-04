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
import { creditsToUsd, formatCredits } from "@/hosted/billing/format";
import {
	filteredLedgerEntries,
	isLedgerFilter,
	type LedgerFilter,
	ledgerEmptyStateCopy,
} from "@/hosted/billing/wallet/ledger-table.logic";
import { cn, relativeTime } from "@/lib/utils";

const OPERATION_LABELS: Record<string, string> = {
	topup: "Top-up",
	invoice: "Top-up",
	x402: "On-chain top-up",
	grant_signup: "Signup grant",
	grant_subscription: "Performance grant",
	grant_redemption: "Redeemed credits",
	grant_referral: "Referral grant",
	admin_adjust: "Adjustment",
	proxy: "Usage",
	refund: "Refund",
};

const STATUS_LABELS: Record<WalletLedgerStatus, string> = {
	applied: "Applied",
	pending: "Pending",
	failed: "Failed",
};

function statusVariant(
	status: WalletLedgerStatus,
): "success" | "warning" | "destructive" | "neutral" {
	if (status === "applied") return "success";
	if (status === "pending") return "warning";
	if (status === "failed") return "destructive";
	return "neutral";
}

function opLabel(op: string): string {
	return OPERATION_LABELS[op] ?? op;
}
function statusLabel(status: WalletLedgerStatus): string {
	return STATUS_LABELS[status] ?? status;
}
function signedAmount(entry: WalletLedgerEntry, pointsPerUsd: number): string {
	const positive = entry.credits_amount >= 0;
	const sign = positive ? "+" : "−";
	const absCredits = Math.abs(entry.credits_amount);
	// Sub-cent rows (e.g. a few credits of usage at 1000 credits/USD) round to
	// "$0.00" and read as misleading zero rows. Show the raw credit amount
	// instead so real, tiny entries stay legible.
	if (absCredits > 0 && pointsPerUsd > 0 && absCredits / pointsPerUsd < 0.005) {
		return `${sign}${formatCredits(absCredits)}`;
	}
	return `${sign}${creditsToUsd(absCredits, pointsPerUsd)}`;
}

export function LedgerTable({
	entries,
	pointsPerUsd,
	isLoading = false,
	hasMore = false,
	atCap = false,
	isFetchingMore = false,
	onShowMore,
}: {
	entries: WalletLedgerEntry[];
	pointsPerUsd: number;
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
				<Select value={filter} onValueChange={handleFilterChange}>
					<SelectTrigger size="sm" className="w-40" aria-label="Filter activity">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="all">All activity</SelectItem>
						<SelectItem value="topup">Top-ups</SelectItem>
						<SelectItem value="grant">Grants</SelectItem>
						<SelectItem value="usage">Usage</SelectItem>
						<SelectItem value="refund">Refunds</SelectItem>
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
							const positive = entry.credits_amount >= 0;
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
										{signedAmount(entry, pointsPerUsd)}
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
									const positive = entry.credits_amount >= 0;
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
												{signedAmount(entry, pointsPerUsd)}
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
