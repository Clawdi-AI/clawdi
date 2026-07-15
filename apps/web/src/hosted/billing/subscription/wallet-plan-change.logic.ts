import type { ComputePlanSlug, WalletComputePlanChangeResult } from "@/hosted/billing/contracts";
import { BillingApiError, isNetworkError, walletComputeErrorDetail } from "@/hosted/billing/errors";
import { decimalCredits } from "@/hosted/billing/wallet/wallet-compute.logic";
import { COMPUTE_BASIC_SLUG, COMPUTE_PERFORMANCE_SLUG } from "./subscription-utils";

export type WalletPlanChangeFailure = {
	kind: "insufficient" | "conflict" | "resize_pending" | "retryable" | "other";
	shortfallCredits: number | null;
};

export function walletPlanTarget(
	current: ComputePlanSlug | null | undefined,
): ComputePlanSlug | null {
	if (current === COMPUTE_BASIC_SLUG) return COMPUTE_PERFORMANCE_SLUG;
	if (current === COMPUTE_PERFORMANCE_SLUG) return COMPUTE_BASIC_SLUG;
	return null;
}

export function walletPlanResultTarget(
	quote: WalletComputePlanChangeResult,
): ComputePlanSlug | null {
	if (quote.target_plan_slug === COMPUTE_BASIC_SLUG) return COMPUTE_BASIC_SLUG;
	if (quote.target_plan_slug === COMPUTE_PERFORMANCE_SLUG) return COMPUTE_PERFORMANCE_SLUG;
	return null;
}

export function walletPlanChangeFailure(error: unknown): WalletPlanChangeFailure {
	const detail = walletComputeErrorDetail(error);
	if (error instanceof BillingApiError && error.status === 402) {
		const value =
			detail && typeof detail !== "string" && "shortfall_credits" in detail
				? detail.shortfall_credits
				: null;
		return {
			kind: "insufficient",
			shortfallCredits: typeof value === "string" ? decimalCredits(value) : null,
		};
	}
	if (error instanceof BillingApiError && error.status === 409) {
		return { kind: "conflict", shortfallCredits: null };
	}
	if (
		error instanceof BillingApiError &&
		error.status === 502 &&
		detail !== null &&
		typeof detail !== "string" &&
		"code" in detail &&
		detail.code === "resize_failed_retryable"
	) {
		return { kind: "resize_pending", shortfallCredits: null };
	}
	if (
		isNetworkError(error) ||
		(error instanceof BillingApiError &&
			error.status >= 500 &&
			detail !== null &&
			typeof detail !== "string" &&
			"retryable" in detail)
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
