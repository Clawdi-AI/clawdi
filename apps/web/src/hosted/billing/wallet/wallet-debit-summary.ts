export type WalletDebitSummary = {
	balanceBeforeUsd: string;
	debitAmountUsd: string;
	balanceAfterUsd: string;
};

export function walletDebitShortfallUsd(
	summary: WalletDebitSummary | null | undefined,
): number | null {
	if (!summary) return null;
	const balanceAfter = Number(summary.balanceAfterUsd);
	return Number.isFinite(balanceAfter) && balanceAfter < 0 ? -balanceAfter : null;
}
