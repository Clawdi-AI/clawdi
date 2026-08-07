import type { ComputeBillingHistoryItem } from "@/hosted/billing/contracts";

export function billingHistoryFundingLabel(
	fundingSource: ComputeBillingHistoryItem["funding_source"],
): string {
	return fundingSource === "wallet" ? "Paid from Wallet" : "Paid by card";
}
