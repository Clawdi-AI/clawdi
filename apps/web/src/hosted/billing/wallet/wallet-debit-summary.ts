import { negativeDecimalMagnitude } from "@/hosted/billing/format";

export type WalletDebitSummary = {
	balanceBeforeUsd: string;
	debitAmountUsd: string;
	balanceAfterUsd: string;
};

export function walletDebitShortfallUsd(
	summary: WalletDebitSummary | null | undefined,
): string | null {
	if (!summary) return null;
	return negativeDecimalMagnitude(summary.balanceAfterUsd);
}
