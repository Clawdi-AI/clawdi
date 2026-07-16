import type { ComputeBillingHistoryItem } from "@/hosted/billing/contracts";

/** Plan C history contains Stripe invoices for both settlement rails. */
export function visibleBillingHistoryRows(
	rows: readonly ComputeBillingHistoryItem[],
): ComputeBillingHistoryItem[] {
	return rows.filter((row) => Boolean(row.stripe_invoice_id));
}

export function billingHistoryFundingLabel(
	fundingSource: ComputeBillingHistoryItem["funding_source"],
): string {
	return fundingSource === "wallet" ? "Paid with AI Credits" : "Paid by card";
}
