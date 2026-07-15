"use client";

import { ExternalLink, Receipt } from "lucide-react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import type { ComputeBillingHistoryItem } from "@/hosted/billing/contracts";
import { billingErrorNormalizer } from "@/hosted/billing/errors";
import { formatCents } from "@/hosted/billing/format";
import { useComputeBillingHistory } from "@/hosted/billing/hooks";
import { computeTierLabel } from "@/hosted/billing/subscription/subscription-utils";
import { formatShortDate } from "@/lib/format";

function statusLabel(status: string): string {
	return status
		.split("_")
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

function statusTone(
	row: ComputeBillingHistoryItem,
): "success" | "warning" | "destructive" | "neutral" {
	if (row.status === "applied" || row.status === "paid") return "success";
	if (row.status === "refunded" || row.status === "waived" || row.status === "void") {
		return "neutral";
	}
	if (row.status === "open" || row.status === "draft") return "warning";
	if (row.status === "uncollectible") return "destructive";
	return "neutral";
}

function periodLabel(row: ComputeBillingHistoryItem): string {
	if (!row.period_start && !row.period_end) return formatShortDate(row.created);
	return `${formatShortDate(row.period_start)} – ${formatShortDate(row.period_end)}`;
}

function planLabel(planSlug: string): string {
	if (planSlug === "compute_basic" || planSlug === "compute_performance") {
		return computeTierLabel(planSlug);
	}
	return planSlug
		.split("_")
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

function InvoiceLink({ row }: { row: ComputeBillingHistoryItem }) {
	if (row.funding_source !== "stripe" || !row.hosted_invoice_url) return null;
	return (
		<Button
			render={<a href={row.hosted_invoice_url} target="_blank" rel="noopener noreferrer" />}
			nativeButton={false}
			variant="outline"
			size="sm"
		>
			Invoice <ExternalLink data-icon="inline-end" />
		</Button>
	);
}

export function BillingHistorySection() {
	const history = useComputeBillingHistory(20);
	const rows = history.data?.pages.flatMap((page) => page.data ?? []) ?? [];

	return (
		<section
			data-hosted="true"
			className="flex flex-col gap-3"
			aria-labelledby="billing-history-title"
		>
			<div>
				<h2 id="billing-history-title" className="text-base font-semibold">
					Billing history
				</h2>
				<p className="text-sm text-muted-foreground">
					Wallet charges and Stripe invoices for paid compute.
				</p>
			</div>

			{history.isLoading ? (
				<div className="flex flex-col gap-px overflow-hidden rounded-lg border">
					{Array.from({ length: 3 }, (_, index) => `history-skeleton-${index}`).map((key) => (
						<div key={key} className="flex items-center justify-between gap-4 px-3 py-3">
							<Skeleton className="h-4 w-40" />
							<Skeleton className="h-4 w-20" />
						</div>
					))}
				</div>
			) : history.error && rows.length === 0 ? (
				<ApiErrorPanel
					normalizer={billingErrorNormalizer}
					error={history.error}
					onRetry={() => void history.refetch()}
					title="Couldn’t load billing history"
				/>
			) : rows.length === 0 ? (
				<EmptyState
					variant="inset"
					icon={Receipt}
					title="No billing history yet"
					description="Paid compute charges will appear here after the first collection."
				/>
			) : (
				<>
					<ul className="divide-y overflow-hidden rounded-lg border sm:hidden">
						{rows.map((row) => (
							<li key={row.id} className="flex items-start justify-between gap-3 p-3">
								<div className="min-w-0">
									<div className="font-medium">{planLabel(row.plan_slug)} compute</div>
									<div className="mt-1 flex flex-wrap items-center gap-2">
										<Badge variant="outline">
											{row.funding_source === "wallet" ? "Wallet" : "Card"}
										</Badge>
										<StatusBadge status={statusTone(row)}>{statusLabel(row.status)}</StatusBadge>
									</div>
									<div className="mt-1 text-xs text-muted-foreground">{periodLabel(row)}</div>
									<div className="mt-2">
										<InvoiceLink row={row} />
									</div>
								</div>
								<span className="shrink-0 font-medium tabular-nums">
									{formatCents(row.amount_cents)}
								</span>
							</li>
						))}
					</ul>

					<div className="hidden overflow-hidden rounded-lg border sm:block">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Period</TableHead>
									<TableHead>Plan</TableHead>
									<TableHead>Funding</TableHead>
									<TableHead>Status</TableHead>
									<TableHead className="text-right">Amount</TableHead>
									<TableHead className="text-right">Receipt</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{rows.map((row) => (
									<TableRow key={row.id}>
										<TableCell className="whitespace-nowrap text-sm text-muted-foreground">
											{periodLabel(row)}
										</TableCell>
										<TableCell className="font-medium">{planLabel(row.plan_slug)}</TableCell>
										<TableCell>
											<Badge variant="outline">
												{row.funding_source === "wallet" ? "Wallet" : "Card"}
											</Badge>
										</TableCell>
										<TableCell>
											<StatusBadge status={statusTone(row)}>{statusLabel(row.status)}</StatusBadge>
										</TableCell>
										<TableCell className="text-right font-medium tabular-nums">
											{formatCents(row.amount_cents)}
										</TableCell>
										<TableCell className="text-right">
											<InvoiceLink row={row} />
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</div>
					{history.hasNextPage ? (
						<div className="flex justify-center">
							<Button
								variant="outline"
								onClick={() => void history.fetchNextPage()}
								disabled={history.isFetchingNextPage}
							>
								{history.isFetchingNextPage ? "Loading…" : "Load more"}
							</Button>
						</div>
					) : null}
				</>
			)}
		</section>
	);
}
