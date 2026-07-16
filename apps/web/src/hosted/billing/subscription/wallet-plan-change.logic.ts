import type { ComputePlanSlug, WalletComputePlanChangeResult } from "@/hosted/billing/contracts";
import { BillingApiError, isNetworkError, walletRefundDebtCredits } from "@/hosted/billing/errors";
import { formatCents } from "@/hosted/billing/format";
import { formatShortDate } from "@/lib/format";
import { COMPUTE_BASIC_SLUG, COMPUTE_PERFORMANCE_SLUG } from "./subscription-utils";

export type WalletPlanChangeFailure = {
	kind: "refund_debt" | "conflict" | "retryable" | "other";
	debtCredits: number | null;
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
	if (error instanceof BillingApiError && error.status === 409) {
		const debtCredits = walletRefundDebtCredits(error);
		return debtCredits === null
			? { kind: "conflict", debtCredits: null }
			: { kind: "refund_debt", debtCredits };
	}
	if (isNetworkError(error) || (error instanceof BillingApiError && error.status >= 500)) {
		return { kind: "retryable", debtCredits: null };
	}
	return { kind: "other", debtCredits: null };
}

export function walletPlanChangeSummary(quote: WalletComputePlanChangeResult): string {
	return `Changes at next renewal on ${formatShortDate(quote.effective_at)} · then ${formatCents(quote.amount_cents)}/mo.`;
}
