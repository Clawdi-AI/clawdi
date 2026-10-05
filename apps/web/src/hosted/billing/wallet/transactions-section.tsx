"use client";

import { transactionsSectionClasses } from "@clawdi/shared/ui";
import {
	billingCopy,
	formatShortDate,
	transactionStatusLabel as statusLabel,
	transactionStatusTone as statusTone,
} from "@clawdi/shared/view";
import { ExternalLink, Receipt } from "lucide-react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { EmptyState } from "@/components/empty-state";
import { SettingsSection } from "@/components/settings-section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import type { WalletTransaction } from "@/hosted/billing/contracts";
import { billingErrorNormalizer } from "@/hosted/billing/errors";
import { useWalletTransactions } from "@/hosted/billing/hooks";
import {
	transactionComputeDetails,
	transactionKindLabel,
	transactionPaymentSourceLabel,
	transactionSignedAmount,
} from "@/hosted/billing/wallet/transactions-section.logic";
import { shouldBlockQueryError } from "@/lib/query-state";
import { cn } from "@/lib/utils";

function TransactionAction({ transaction }: { transaction: WalletTransaction }) {
	const action = transaction.receipt_url
		? { label: "Receipt", url: transaction.receipt_url }
		: transaction.hosted_invoice_url
			? { label: "Invoice", url: transaction.hosted_invoice_url }
			: null;
	if (!action) return <span className={transactionsSectionClasses.muted}>—</span>;
	return (
		<Button
			render={<a href={action.url} target="_blank" rel="noopener noreferrer" />}
			nativeButton={false}
			variant="link"
			size="xs"
			className={transactionsSectionClasses.inlineAction}
		>
			{action.label} <ExternalLink data-icon="inline-end" />
		</Button>
	);
}

function TransactionDescription({ transaction }: { transaction: WalletTransaction }) {
	const details = transactionComputeDetails(transaction);
	return (
		<div className={transactionsSectionClasses.minWidth}>
			<div className={transactionsSectionClasses.label}>
				{transactionKindLabel(transaction.kind)}
			</div>
			{details.map((detail) => (
				<div key={detail} className={transactionsSectionClasses.reference}>
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
				transactionsSectionClasses.amount,
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
		transactions.hasNextPage && !transactions.isError ? (
			<div className={transactionsSectionClasses.pagination}>
				<Button
					size="sm"
					variant="outline"
					onClick={() => {
						if (!transactions.isFetching) void transactions.fetchNextPage({ cancelRefetch: false });
					}}
					disabled={transactions.isFetching}
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
			title={billingCopy.transactions}
			description={billingCopy.transactionsDescription}
		>
			<div className={transactionsSectionClasses.section}>
				{transactions.isLoading ? (
					<div className={transactionsSectionClasses.skeletons}>
						{Array.from({ length: 5 }, (_, index) => `transaction-${index}`).map((key) => (
							<div key={key} className={transactionsSectionClasses.skeletonRow}>
								<Skeleton className={transactionsSectionClasses.skeletonLabel} />
								<Skeleton className={transactionsSectionClasses.skeletonAmount} />
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
						title={billingCopy.emptyTransactions}
						description={billingCopy.emptyTransactionsDescription}
					/>
				) : (
					<>
						<ul className={transactionsSectionClasses.mobileRows}>
							{rows.map((transaction) => (
								<li key={transaction.id} className={transactionsSectionClasses.mobileRow}>
									<div className={transactionsSectionClasses.mobileCopy}>
										<TransactionDescription transaction={transaction} />
										<div className={transactionsSectionClasses.mobileHeading}>
											<Badge variant="outline">
												{transactionPaymentSourceLabel(transaction.funding)}
											</Badge>
											<StatusBadge status={statusTone(transaction.status)}>
												{statusLabel(transaction.status)}
											</StatusBadge>
											<span className={transactionsSectionClasses.description}>
												{formatShortDate(transaction.occurred_at)}
											</span>
										</div>
										<TransactionAction transaction={transaction} />
									</div>
									<TransactionAmount transaction={transaction} />
								</li>
							))}
						</ul>

						<div className={transactionsSectionClasses.desktopTable}>
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>Type</TableHead>
										<TableHead>Payment source</TableHead>
										<TableHead>Status</TableHead>
										<TableHead className={transactionsSectionClasses.amountColumn}>
											Amount
										</TableHead>
										<TableHead className={transactionsSectionClasses.amountColumn}>Date</TableHead>
										<TableHead className={transactionsSectionClasses.amountColumn}>
											Receipt / invoice
										</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{rows.map((transaction) => (
										<TableRow key={transaction.id}>
											<TableCell className={transactionsSectionClasses.referenceColumn}>
												<TransactionDescription transaction={transaction} />
											</TableCell>
											<TableCell>
												<Badge variant="outline">
													{transactionPaymentSourceLabel(transaction.funding)}
												</Badge>
											</TableCell>
											<TableCell>
												<StatusBadge status={statusTone(transaction.status)}>
													{statusLabel(transaction.status)}
												</StatusBadge>
											</TableCell>
											<TableCell className={transactionsSectionClasses.amountColumn}>
												<TransactionAmount transaction={transaction} />
											</TableCell>
											<TableCell className={transactionsSectionClasses.desktopAmount}>
												{formatShortDate(transaction.occurred_at)}
											</TableCell>
											<TableCell className={transactionsSectionClasses.amountColumn}>
												<TransactionAction transaction={transaction} />
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						</div>
						<p className={transactionsSectionClasses.description}>
							Showing {rows.length} transactions
						</p>
						{loadMore}
					</>
				)}
				{transactions.isFetchNextPageError || transactions.isRefetchError ? (
					<ApiErrorPanel
						normalizer={billingErrorNormalizer}
						error={transactions.error}
						onRetry={() => {
							if (!transactions.isFetching) void transactions.refetch({ cancelRefetch: false });
						}}
						title={
							transactions.isFetchNextPageError
								? "Couldn’t load more transactions"
								: "Couldn’t refresh transactions"
						}
					/>
				) : null}
			</div>
		</SettingsSection>
	);
}
