export type WalletDebitSummary = {
	balanceBeforeCredits: string;
	exactDebitCredits: string;
	exactDebitCents: number;
	balanceAfterCredits: string;
	pointsPerUsd: number;
};

export function walletDebitShortfallCredits(
	summary: WalletDebitSummary | null | undefined,
): number | null {
	if (!summary) return null;
	const balanceAfter = Number(summary.balanceAfterCredits);
	return Number.isFinite(balanceAfter) && balanceAfter < 0 ? -balanceAfter : null;
}
