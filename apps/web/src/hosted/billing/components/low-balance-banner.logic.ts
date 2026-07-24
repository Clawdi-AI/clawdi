import type { WalletState } from "@/hosted/billing/contracts";
import { isLowBalance } from "@/hosted/billing/wallet/wallet-constants";

/** Which primary CTA the banner should lead with. */
export type LowBalanceCta = "confirm" | "retry" | "top-up" | "none";

export interface LowBalanceBannerState {
	/** Whether the banner renders at all. */
	show: boolean;
	/** A pending auto-reload attempt exists (SCA pending or declined). */
	hasAction: boolean;
	/** The last auto-reload was declined (vs. just awaiting SCA). */
	declined: boolean;
	/** Awaiting bank confirmation (SCA), not declined. */
	needsAction: boolean;
	/** Balance is below the low-balance threshold. */
	low: boolean;
	primaryCta: LowBalanceCta;
}

/**
 * Pure decision for the low-balance / payment-attention banner. A pending
 * auto-reload action (SCA or decline) takes priority and points the user at the
 * confirm control on the auto-reload card; otherwise a low balance shows a
 * top-up CTA. Returns `show: false` when there's nothing to surface.
 */
export function lowBalanceBannerState(wallet: WalletState | undefined): LowBalanceBannerState {
	if (!wallet) {
		return {
			show: false,
			hasAction: false,
			declined: false,
			needsAction: false,
			low: false,
			primaryCta: "none",
		};
	}
	const action = wallet.auto_reload_action;
	const hasAction = action != null;
	const declined = action?.error_code != null;
	const needsAction = hasAction && !declined;
	const low = isLowBalance(wallet.balance_usd);
	const show = low || hasAction;
	const primaryCta: LowBalanceCta = hasAction
		? declined
			? "retry"
			: "confirm"
		: low
			? "top-up"
			: "none";
	return { show, hasAction, declined, needsAction, low, primaryCta };
}
