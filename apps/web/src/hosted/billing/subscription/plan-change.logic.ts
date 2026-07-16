import type { ComputePlanSlug } from "@/hosted/billing/contracts";
import { COMPUTE_BASIC_SLUG, COMPUTE_PERFORMANCE_SLUG } from "./subscription-utils";

export type PlanChangeSelection = {
	planSlug: ComputePlanSlug;
	billingTermMonths: number;
};

export type PlanChangeQuoteView = {
	operationId: string;
	fundingSource: "stripe" | "wallet";
	targetPlanSlug: ComputePlanSlug;
	targetBillingTermMonths: number;
	changeKind: "immediate_upgrade" | "scheduled_downgrade";
	effectiveAt: string;
	expiresAt: string;
	amountCents: number;
	amountCredits: string | null;
};

const UNSIGNED_DECIMAL = /^(\d+)(?:\.(\d+))?$/;

function decimalParts(value: string): { units: bigint; scale: number } | null {
	const match = UNSIGNED_DECIMAL.exec(value.trim());
	if (!match) return null;
	const whole = match[1] ?? "0";
	const fraction = match[2] ?? "";
	return {
		units: BigInt(`${whole}${fraction}`),
		scale: fraction.length,
	};
}

function scaledUnits(parts: { units: bigint; scale: number }, scale: number): bigint {
	return parts.units * 10n ** BigInt(scale - parts.scale);
}

function decimalString(units: bigint, scale: number): string {
	const negative = units < 0n;
	const digits = (negative ? -units : units).toString().padStart(scale + 1, "0");
	const whole = scale === 0 ? digits : digits.slice(0, -scale);
	const fraction = scale === 0 ? "" : digits.slice(-scale).replace(/0+$/, "");
	return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/** Subtract a decimal-string debit without rounding through a JavaScript number. */
export function walletBalanceAfterDebit(
	balanceBeforeCredits: string,
	exactDebitCredits: string,
): string | null {
	const balance = decimalParts(balanceBeforeCredits);
	const debit = decimalParts(exactDebitCredits);
	if (!balance || !debit) return null;
	const scale = Math.max(balance.scale, debit.scale);
	return decimalString(scaledUnits(balance, scale) - scaledUnits(debit, scale), scale);
}

export function defaultPlanChangeSelection(
	currentPlanSlug: ComputePlanSlug,
	currentBillingTermMonths: number,
): PlanChangeSelection {
	return {
		planSlug:
			currentPlanSlug === COMPUTE_PERFORMANCE_SLUG ? COMPUTE_BASIC_SLUG : COMPUTE_PERFORMANCE_SLUG,
		billingTermMonths: currentBillingTermMonths,
	};
}

export function isSamePlanChangeSelection(
	selection: PlanChangeSelection,
	currentPlanSlug: ComputePlanSlug,
	currentBillingTermMonths: number,
): boolean {
	return (
		selection.planSlug === currentPlanSlug &&
		selection.billingTermMonths === currentBillingTermMonths
	);
}

export function planChangeUnavailableReason({
	canUsePlanCBilling,
	cancelAtPeriodEnd,
	status,
	subscriptionId,
}: {
	canUsePlanCBilling: boolean;
	cancelAtPeriodEnd: boolean;
	status: string;
	subscriptionId: number | null;
}): string | null {
	if (!canUsePlanCBilling)
		return "Plan changes are unavailable while the new billing system rolls out.";
	if (cancelAtPeriodEnd)
		return "Resume this subscription before changing its plan or billing term.";
	if (!subscriptionId)
		return "Plan changes will be available after subscription details finish syncing.";
	if (status !== "active" && status !== "trialing") {
		return "Resolve the subscription status before changing its plan or billing term.";
	}
	return null;
}
