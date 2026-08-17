import type { WalletAutoReloadAction, WalletState } from "@/hosted/billing/contracts";

export type WalletCacheSnapshot = Omit<WalletState, "auto_reload_action"> & {
	auto_reload_action?: Omit<WalletAutoReloadAction, "client_secret"> | null;
};

/**
 * Allowlist the wallet fields that are safe for TanStack Query to own.
 * Payment-attempt client secrets are fetched imperatively and kept in the
 * payment component for only the lifetime of that attempt.
 */
export function walletSnapshotForCache(wallet: WalletState): WalletCacheSnapshot {
	const snapshot: Omit<WalletCacheSnapshot, "auto_reload_action"> = {
		balance_usd: wallet.balance_usd,
		x402_enabled: wallet.x402_enabled,
		x402_payment_authority: wallet.x402_payment_authority,
		x402_payment_status: wallet.x402_payment_status,
		x402_payment_attempt: wallet.x402_payment_attempt,
		auto_reload_enabled: wallet.auto_reload_enabled,
		auto_reload_has_payment_method: wallet.auto_reload_has_payment_method,
		auto_reload_card: wallet.auto_reload_card,
		auto_reload_currency: wallet.auto_reload_currency,
		auto_reload_required_consent_version: wallet.auto_reload_required_consent_version,
		auto_reload_amount_policy: wallet.auto_reload_amount_policy,
		auto_reload_consent_version: wallet.auto_reload_consent_version,
		auto_reload_consented_at: wallet.auto_reload_consented_at,
		auto_reload_threshold_usd: wallet.auto_reload_threshold_usd,
		auto_reload_amount_cents: wallet.auto_reload_amount_cents,
		auto_reload_monthly_cap_cents: wallet.auto_reload_monthly_cap_cents,
		auto_reload_monthly_spent_cents: wallet.auto_reload_monthly_spent_cents,
		auto_reload_period_end: wallet.auto_reload_period_end,
		auto_reload_status: wallet.auto_reload_status,
	};
	const action = wallet.auto_reload_action;
	if (action === undefined) return snapshot;
	if (action === null) return { ...snapshot, auto_reload_action: null };
	return {
		...snapshot,
		auto_reload_action: {
			attempt_id: action.attempt_id,
			payment_intent_id: action.payment_intent_id,
			error_code: action.error_code,
		},
	};
}
