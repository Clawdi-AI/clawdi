import type { DeployComponents } from "../api";
import { formatUsdExact } from "./billing-format";
import { isLowBalance } from "./billing-wallet-constants";

type Wallet = DeployComponents["schemas"]["V2WalletResponse"];
type BannerWallet = Pick<Wallet, "balance_usd"> & {
	auto_reload_action?: Pick<NonNullable<Wallet["auto_reload_action"]>, "error_code"> | null;
};

export const lowBalanceBannerCopy = {
	retryPayment: "Retry payment",
	confirmPayment: "Confirm payment",
	setUpAutoReload: "Set up auto-reload",
} as const;

export type LowBalanceBannerView = {
	tone: "default" | "destructive";
	title: string;
	body: string;
	/** A pending auto-reload attempt (bank confirmation or decline) needs action. */
	hasAction: boolean;
	declined: boolean;
};

/**
 * Low-balance / payment-attention banner. A pending auto-reload action takes priority over a
 * low balance; null when there is nothing to surface. Without card billing (store builds)
 * auto-reload does not exist, so only the low balance shows and the copy omits it.
 */
export function lowBalanceBannerView(
	wallet: BannerWallet | undefined,
	{ hasWalletCompute, cardBilling }: { hasWalletCompute: boolean; cardBilling: boolean },
): LowBalanceBannerView | null {
	if (!wallet) return null;
	const action = cardBilling ? wallet.auto_reload_action : null;
	const hasAction = action != null;
	const declined = action?.error_code != null;
	if (!hasAction && !isLowBalance(wallet.balance_usd)) return null;
	const services = hasWalletCompute ? "Clawdi AI and wallet-funded compute" : "Clawdi AI";
	if (declined) {
		return {
			tone: "destructive",
			title: "Auto-reload was declined",
			body: `We couldn't charge your saved card. Top up or update your payment method to keep ${services} running.`,
			hasAction,
			declined,
		};
	}
	if (hasAction) {
		return {
			tone: "default",
			title: "Your bank needs to confirm a top-up",
			body: `A top-up is waiting for your bank to confirm it. ${services} may pause if your balance stays low.`,
			hasAction,
			declined,
		};
	}
	return {
		tone: "default",
		title: "Your wallet balance is running low",
		body: `You have about ${formatUsdExact(wallet.balance_usd)} left. Top up${cardBilling ? " or turn on auto-reload" : ""} to keep ${services} running.`,
		hasAction,
		declined,
	};
}
