import type { ComputeBillingHistoryItem } from "@/hosted/billing/contracts";

export function billingHistoryFundingLabel(
	fundingSource: ComputeBillingHistoryItem["funding_source"],
): string {
	return fundingSource === "wallet" ? "Paid with AI Credits" : "Paid by card";
}
