"use client";

import { transactionsSectionClasses } from "@clawdi/shared/ui";
import {
	billingCopy,
	formatShortDate,
	transactionStatusLabel as statusLabel,
	transactionStatusTone as statusTone,
	transactionDocumentAction,
	transactionsCountLabel,
} from "@clawdi/shared/view";
import { ExternalLink, Receipt } from "lucide-react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { EmptyState } from "@/components/empty-state";
import { SettingsSection } from "@/components/settings-section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { TransactionRowsSkeleton } from "@/hosted/billing/components/state-views";
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

function TransactionAction({
	transaction,
	placeholder = false,
}: {
	transaction: WalletTransaction;
	/** Only a table cell needs a dash; stacked rows simply omit the missing document. */
	placeholder?: boolean;
}) {
	const action = transactionDocumentAction(transaction);
	if (!action) {
		return placeholder ? <span className={transactionsSectionClasses.muted}>—</span> : null;
	}
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
		<div className={transactionsSectionClasses.descriptionBody}>
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
					<TransactionRowsSkeleton />
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
												<TransactionAction transaction={transaction} placeholder />
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						</div>
						<p className={transactionsSectionClasses.description}>
							{transactionsCountLabel(rows.length)}
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
