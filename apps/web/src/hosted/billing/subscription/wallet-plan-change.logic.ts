import type { ComputePlanSlug, WalletComputePlanChangeResult } from "@/hosted/billing/contracts";
import { BillingApiError, billingErrorDetail, isNetworkError } from "@/hosted/billing/errors";
import { decimalCredits } from "@/hosted/billing/wallet/wallet-compute.logic";
import { COMPUTE_BASIC_SLUG, COMPUTE_PERFORMANCE_SLUG } from "./subscription-utils";

export type WalletPlanChangeFailure = {
	kind: "insufficient" | "conflict" | "retryable" | "other";
	shortfallCredits: number | null;
};

export function walletPlanTarget(
	current: ComputePlanSlug | null | undefined,
): ComputePlanSlug | null {
	if (current === COMPUTE_BASIC_SLUG) return COMPUTE_PERFORMANCE_SLUG;
	if (current === COMPUTE_PERFORMANCE_SLUG) return COMPUTE_BASIC_SLUG;
	return null;
}

export function walletPlanChangeFailure(error: unknown): WalletPlanChangeFailure {
	const detail = billingErrorDetail(error);
	if (error instanceof BillingApiError && error.status === 402) {
		const value = detail?.shortfall_credits;
		return {
			kind: "insufficient",
			shortfallCredits: typeof value === "string" ? decimalCredits(value) : null,
		};
	}
	if (error instanceof BillingApiError && error.status === 409) {
		return { kind: "conflict", shortfallCredits: null };
	}
	if (
		isNetworkError(error) ||
		(error instanceof BillingApiError && error.status >= 500 && detail?.retryable === true)
	) {
		return { kind: "retryable", shortfallCredits: null };
	}
	return { kind: "other", shortfallCredits: null };
}

export function walletPlanChangeSummary(quote: WalletComputePlanChangeResult): string {
	return quote.change_kind === "upgrade"
		? "The prorated difference is charged from Wallet now, then compute resizes immediately."
		: "The current plan stays active until the next renewal, when the lower monthly charge begins.";
}
