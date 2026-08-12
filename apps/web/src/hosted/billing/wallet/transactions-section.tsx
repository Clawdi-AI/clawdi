"use client";

import { ExternalLink, Receipt } from "lucide-react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { EmptyState } from "@/components/empty-state";
import { SettingsSection } from "@/components/settings-section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import type { WalletTransaction } from "@/hosted/billing/contracts";
import { billingErrorNormalizer } from "@/hosted/billing/errors";
import { useWalletTransactions } from "@/hosted/billing/hooks";
import {
	transactionComputeDetails,
	transactionKindLabel,
	transactionSignedAmount,
} from "@/hosted/billing/wallet/transactions-section.logic";
import { formatShortDate } from "@/lib/format";
import { shouldBlockQueryError } from "@/lib/query-state";
import { cn } from "@/lib/utils";

const STATUS_LABELS: Record<string, string> = {
	applied: "Completed",
	paid: "Paid",
	succeeded: "Completed",
	pending: "Pending",
	processing: "Processing",
	failed: "Failed",
	refunded: "Refunded",
	waived: "Waived",
	void: "Void",
	open: "Open",
	draft: "Draft",
	uncollectible: "Uncollectible",
};

function statusLabel(status: string): string {
	return STATUS_LABELS[status] ?? "Processing";
}

function statusTone(status: string): StatusTone {
	if (["applied", "paid", "succeeded"].includes(status)) return "success";
	if (["pending", "processing", "open", "draft"].includes(status)) return "warning";
	if (["failed", "uncollectible"].includes(status)) return "destructive";
	return "neutral";
}

function TransactionAction({ transaction }: { transaction: WalletTransaction }) {
	const action = transaction.receipt_url
		? { label: "Receipt", url: transaction.receipt_url }
		: transaction.hosted_invoice_url
			? { label: "Invoice", url: transaction.hosted_invoice_url }
			: null;
	if (!action) return <span className="text-muted-foreground">—</span>;
	return (
		<Button
			render={<a href={action.url} target="_blank" rel="noopener noreferrer" />}
			nativeButton={false}
			variant="link"
			size="xs"
			className="h-auto px-0"
		>
			{action.label} <ExternalLink data-icon="inline-end" />
		</Button>
	);
}

function TransactionDescription({ transaction }: { transaction: WalletTransaction }) {
	const details = transactionComputeDetails(transaction);
	return (
		<div className="min-w-0">
			<div className="font-medium">{transactionKindLabel(transaction.kind)}</div>
			{details.map((detail) => (
				<div key={detail} className="truncate text-xs text-muted-foreground">
					{detail}
				</div>
			))}
		</div>
	);
}

function TransactionAmount({ transaction }: { transaction: WalletTransaction }) {
	return (
		<span
			className={cn(
				"shrink-0 font-medium tabular-nums",
				transaction.direction === "credit" && "text-success-muted-foreground",
			)}
		>
			{transactionSignedAmount(transaction)}
		</span>
	);
}

export function TransactionsSection() {
	const transactions = useWalletTransactions();
	const rows = transactions.data?.pages.flatMap((page) => page.items) ?? [];
	const loadMore =
		transactions.hasNextPage && !transactions.isFetchNextPageError ? (
			<div className="flex justify-center">
				<Button
					size="sm"
					variant="outline"
					onClick={() => void transactions.fetchNextPage()}
					disabled={transactions.isFetchingNextPage}
				>
					{transactions.isFetchingNextPage ? (
						<>
							<Spinner /> Loading…
						</>
					) : (
						"Load more"
					)}
				</Button>
			</div>
		) : null;

	return (
		<SettingsSection
			id="transactions"
			data-hosted="true"
			headingLevel={3}
			title="Transactions"
			description="Every movement of money, including card-paid subscriptions."
		>
			<div className="flex flex-col gap-4">
				{transactions.isLoading ? (
					<div className="space-y-px overflow-hidden rounded-lg border">
						{Array.from({ length: 5 }, (_, index) => `transaction-${index}`).map((key) => (
							<div key={key} className="flex items-center justify-between gap-4 px-3 py-3">
								<Skeleton className="h-4 w-40" />
								<Skeleton className="h-4 w-16" />
							</div>
						))}
					</div>
				) : shouldBlockQueryError(transactions.error, transactions.data) ? (
					<ApiErrorPanel
						normalizer={billingErrorNormalizer}
						error={transactions.error}
						onRetry={() => void transactions.refetch()}
						title="Couldn’t load transactions"
					/>
				) : rows.length === 0 ? (
					<EmptyState
						variant="inset"
						icon={Receipt}
						title="No transactions yet"
						description="Top-ups, grants, compute charges, and other money movements will appear here."
					/>
				) : (
					<>
						<ul className="divide-y overflow-hidden rounded-lg border md:hidden">
							{rows.map((transaction) => (
								<li key={transaction.id} className="flex items-start justify-between gap-3 p-3">
									<div className="min-w-0 space-y-1.5">
										<TransactionDescription transaction={transaction} />
										<div className="flex flex-wrap items-center gap-2">
											<Badge variant="outline">
												{transaction.funding === "wallet" ? "Wallet" : "Card"}
											</Badge>
											<StatusBadge status={statusTone(transaction.status)}>
												{statusLabel(transaction.status)}
											</StatusBadge>
											<span className="text-xs text-muted-foreground">
												{formatShortDate(transaction.occurred_at)}
											</span>
										</div>
										<TransactionAction transaction={transaction} />
									</div>
									<TransactionAmount transaction={transaction} />
								</li>
							))}
						</ul>

						<div className="hidden overflow-x-auto rounded-lg border md:block">
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>Type</TableHead>
										<TableHead>Funding</TableHead>
										<TableHead>Status</TableHead>
										<TableHead className="text-right">Amount</TableHead>
										<TableHead className="text-right">Date</TableHead>
										<TableHead className="text-right">Receipt / invoice</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{rows.map((transaction) => (
										<TableRow key={transaction.id}>
											<TableCell className="max-w-[18rem]">
												<TransactionDescription transaction={transaction} />
											</TableCell>
											<TableCell>
												<Badge variant="outline">
													{transaction.funding === "wallet" ? "Wallet" : "Card"}
												</Badge>
											</TableCell>
											<TableCell>
												<StatusBadge status={statusTone(transaction.status)}>
													{statusLabel(transaction.status)}
												</StatusBadge>
											</TableCell>
											<TableCell className="text-right">
												<TransactionAmount transaction={transaction} />
											</TableCell>
											<TableCell className="whitespace-nowrap text-right text-sm text-muted-foreground">
												{formatShortDate(transaction.occurred_at)}
											</TableCell>
											<TableCell className="text-right">
												<TransactionAction transaction={transaction} />
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						</div>
						{loadMore}
					</>
				)}
				{transactions.isFetchNextPageError ? (
					<ApiErrorPanel
						normalizer={billingErrorNormalizer}
						error={transactions.error}
						onRetry={() => void transactions.fetchNextPage()}
						title="Couldn’t load more transactions"
					/>
				) : null}
			</div>
		</SettingsSection>
	);
}
