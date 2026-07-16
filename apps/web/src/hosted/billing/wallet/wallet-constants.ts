/**
 * Wallet UI bounds. These mirror the hosted API validation so the form catches
 * out-of-range input before the request, but the backend remains the source of
 * truth.
 */

// Top-up: $10–$2,000 (WALLET_TOPUP_MIN/MAX_CENTS).
export const TOPUP_MIN_CENTS = 1000;
export const TOPUP_MAX_CENTS = 200_000;
export const TOPUP_DEFAULT_CENTS = 2500;
export const TOPUP_INCREMENT_CENTS = 100;
export const TOPUP_PRESETS_CENTS = [1000, 2500, 5000, 10_000, 25_000];

// Auto-reload: amount $5–$500, threshold ≥ $1 (1000 credits), cap ≥ 0 (0 = off).
export const AUTORELOAD_AMOUNT_MIN_CENTS = 500;
export const AUTORELOAD_AMOUNT_MAX_CENTS = 50_000;
export const AUTORELOAD_THRESHOLD_MIN_CREDITS = 1000;

// Low-balance warning trips below $2.
export const LOW_BALANCE_USD = 2;

// Ledger: fetch a page at a time and cap the client-side window so a wallet
// with thousands of entries can never render thousands of rows. "Show more"
// steps up by a page until the cap, then the table states it's capped.
export const LEDGER_PAGE_SIZE = 50;
export const LEDGER_MAX_ROWS = 100;

export function isLowBalance(balanceCredits: number, pointsPerUsd: number): boolean {
	if (!pointsPerUsd) return false;
	return balanceCredits / pointsPerUsd < LOW_BALANCE_USD;
}
