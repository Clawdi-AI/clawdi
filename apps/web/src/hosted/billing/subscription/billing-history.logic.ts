import type { ComputeBillingHistoryItem } from "@/hosted/billing/contracts";

export function billingHistoryFundingLabel(
	fundingSource: ComputeBillingHistoryItem["funding_source"],
): string {
	return fundingSource === "wallet" ? "Paid from Wallet" : "Paid by card";
}

export function billingHistoryEmptyStateCopy(hasMore: boolean): {
	title: string;
	description: string;
} {
	return hasMore
		? {
				title: "No matching invoices on this page",
				description: "Load more to check older billing history.",
			}
		: {
				title: "No billing history yet",
				description: "Paid compute invoices will appear here after the first collection.",
			};
}
