import { formatCents } from "@/hosted/billing/format";

/**
 * Wallet UI bounds. These mirror the hosted API validation so the form catches
 * out-of-range input before the request, but the backend remains the source of
 * truth.
 */

// Top-up bounds (WALLET_TOPUP_MIN/MAX_CENTS).
export const TOPUP_MIN_CENTS = 1000;
export const TOPUP_MAX_CENTS = 200_000;
export const TOPUP_DEFAULT_CENTS = 2500;
export const TOPUP_INCREMENT_CENTS = 100;
export const TOPUP_PRESETS_CENTS = [1000, 2500, 5000, 10_000, 25_000];

// Auto-reload amount bounds; threshold ≥ $1, and 0 means no monthly limit.
export const AUTORELOAD_AMOUNT_MIN_CENTS = 500;
export const AUTORELOAD_AMOUNT_MAX_CENTS = 50_000;
export const AUTORELOAD_MONTHLY_CAP_MAX_CENTS = 2_147_483_647;
export const AUTORELOAD_THRESHOLD_MIN_USD = 1;

function amountRangeLabel(minCents: number, maxCents: number): string {
	return `${formatCents(minCents)}–${formatCents(maxCents)}`;
}

export const TOPUP_AMOUNT_RANGE_LABEL = amountRangeLabel(TOPUP_MIN_CENTS, TOPUP_MAX_CENTS);
export const AUTORELOAD_AMOUNT_RANGE_LABEL = amountRangeLabel(
	AUTORELOAD_AMOUNT_MIN_CENTS,
	AUTORELOAD_AMOUNT_MAX_CENTS,
);

// Low-balance warning trips below $2.
export const LOW_BALANCE_USD = 2;

export function isLowBalance(balanceUsd: string): boolean {
	const balance = Number(balanceUsd);
	return Number.isFinite(balance) && balance < LOW_BALANCE_USD;
}
