import type { WalletComputeQuoteResponse } from "@/hosted/billing/contracts";

/**
 * Presentation boundary for the public wallet-subscription quote contract.
 * Keep generated wire names here so billing UI consumes stable debit semantics.
 */
export function walletSubscriptionDebitSummary(quote: WalletComputeQuoteResponse) {
	return {
		balanceBeforeCredits: quote.balance_credits,
		exactDebitCredits: quote.first_charge_credits,
		exactDebitCents: quote.first_charge_cents,
		balanceAfterCredits: quote.post_charge_balance_estimate_credits,
		pointsPerUsd: quote.points_per_usd,
		hasOpenRefundDebt: quote.warnings?.includes("open_refund_debt") ?? false,
		hasLowCoverage: quote.warnings?.includes("low_coverage") ?? false,
	};
}

export function walletDebitShortfallCredits(
	summary: ReturnType<typeof walletSubscriptionDebitSummary> | null | undefined,
): number | null {
	if (!summary) return null;
	const balanceAfter = Number(summary.balanceAfterCredits);
	return Number.isFinite(balanceAfter) && balanceAfter < 0 ? -balanceAfter : null;
}
