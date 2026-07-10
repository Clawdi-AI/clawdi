"use client";

import { ExternalLink, Receipt } from "lucide-react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { EmptyState } from "@/components/empty-state";
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
import type { ComputeInvoice } from "@/hosted/billing/contracts";
import { billingErrorNormalizer } from "@/hosted/billing/errors";
import { formatCents } from "@/hosted/billing/format";
import { useComputeInvoices } from "@/hosted/billing/hooks";
import { formatShortDate } from "@/lib/format";

function invoiceStatusLabel(status: string | null | undefined): string {
	if (!status) return "Unknown";
	return status
		.split("_")
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

function invoiceStatusTone(
	status: string | null | undefined,
): "success" | "warning" | "destructive" | "neutral" {
	if (status === "paid") return "success";
	if (status === "open" || status === "draft") return "warning";
	if (status === "uncollectible" || status === "void") return "destructive";
	return "neutral";
}

function InvoiceLink({ invoice }: { invoice: ComputeInvoice }) {
	if (!invoice.hosted_invoice_url) {
		return <span className="text-xs text-muted-foreground">Unavailable</span>;
	}
	return (
		<Button
			render={<a href={invoice.hosted_invoice_url} target="_blank" rel="noopener noreferrer" />}
			nativeButton={false}
			variant="outline"
			size="sm"
		>
			Open
			<ExternalLink data-icon="inline-end" />
		</Button>
	);
}

function invoiceDisplayNumber(invoice: ComputeInvoice): string {
	return invoice.number || invoice.id;
}

export function InvoicesSection() {
	const invoices = useComputeInvoices(12);
	const rows = invoices.data?.data ?? [];

	return (
		<section data-hosted="true" className="flex flex-col gap-3" aria-labelledby="invoices-title">
			<div className="flex items-center justify-between gap-2">
				<div>
					<h2 id="invoices-title" className="text-base font-semibold">
						Invoices
					</h2>
					<p className="text-sm text-muted-foreground">
						Recent Performance compute invoices from Stripe.
					</p>
				</div>
			</div>

			{invoices.isLoading ? (
				<div className="flex flex-col gap-px overflow-hidden rounded-lg border">
					{Array.from({ length: 3 }, (_, i) => `invoice-skeleton-${i}`).map((key) => (
						<div key={key} className="flex items-center justify-between gap-4 px-3 py-3">
							<Skeleton className="h-4 w-40" />
							<Skeleton className="h-4 w-20" />
						</div>
					))}
				</div>
			) : invoices.error ? (
				<ApiErrorPanel
					normalizer={billingErrorNormalizer}
					error={invoices.error}
					onRetry={() => {
						void invoices.refetch();
					}}
					title="Couldn’t load invoices"
				/>
			) : rows.length === 0 ? (
				<EmptyState
					variant="inset"
					icon={Receipt}
					title="No invoices yet"
					description="Performance compute invoices will appear here after Stripe creates them."
				/>
			) : (
				<>
					<ul className="divide-y overflow-hidden rounded-lg border sm:hidden">
						{rows.map((invoice) => (
							<li key={invoice.id} className="flex items-start justify-between gap-3 p-3">
								<div className="min-w-0">
									<div className="truncate font-medium">{invoiceDisplayNumber(invoice)}</div>
									<div className="mt-1 flex flex-wrap items-center gap-2">
										<StatusBadge status={invoiceStatusTone(invoice.status)}>
											{invoiceStatusLabel(invoice.status)}
										</StatusBadge>
										<span className="text-xs text-muted-foreground">
											{formatShortDate(invoice.created)}
										</span>
									</div>
									<div className="mt-2">
										<InvoiceLink invoice={invoice} />
									</div>
								</div>
								<span className="shrink-0 font-medium tabular-nums">
									{formatCents(invoice.amount_cents)}
								</span>
							</li>
						))}
					</ul>

					<div className="hidden overflow-hidden rounded-lg border sm:block">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Invoice</TableHead>
									<TableHead>Status</TableHead>
									<TableHead className="text-right">Amount</TableHead>
									<TableHead className="text-right">Date</TableHead>
									<TableHead className="text-right">Link</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{rows.map((invoice) => (
									<TableRow key={invoice.id}>
										<TableCell className="font-medium">{invoiceDisplayNumber(invoice)}</TableCell>
										<TableCell>
											<StatusBadge status={invoiceStatusTone(invoice.status)}>
												{invoiceStatusLabel(invoice.status)}
											</StatusBadge>
										</TableCell>
										<TableCell className="text-right font-medium tabular-nums">
											{formatCents(invoice.amount_cents)}
										</TableCell>
										<TableCell className="whitespace-nowrap text-right text-sm text-muted-foreground">
											{formatShortDate(invoice.created)}
										</TableCell>
										<TableCell className="text-right">
											<InvoiceLink invoice={invoice} />
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</div>
				</>
			)}
		</section>
	);
}
