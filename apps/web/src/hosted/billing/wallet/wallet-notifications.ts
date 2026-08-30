import type { ActionRequiredNotification } from "@/components/notification-center.logic";
import { lowBalanceBannerState } from "@/hosted/billing/components/low-balance-banner.logic";
import { formatUsdExact } from "@/hosted/billing/format";
import type { WalletCacheSnapshot } from "@/hosted/billing/wallet/wallet-cache";

export function walletNotificationCenterItems(
	wallet: WalletCacheSnapshot | undefined,
): ActionRequiredNotification[] {
	if (!wallet) return [];

	const state = lowBalanceBannerState(wallet);
	const action = wallet.auto_reload_action;
	if (action) {
		return [
			{
				id: `wallet-auto-reload-${action.attempt_id}`,
				title: state.declined ? "Auto-reload was declined" : "Your bank needs to confirm a top-up",
				description: state.declined
					? "We couldn’t charge your saved card. Retry or update your payment method before the remaining balance runs out."
					: "A top-up is waiting for confirmation from your bank. Confirm it before the remaining balance runs out.",
				badge: "Wallet",
				actionLabel: state.declined ? "Retry payment" : "Confirm payment",
				severity: state.declined ? "destructive" : "warning",
			},
		];
	}

	if (wallet.auto_reload_status === "payment_failed") {
		return [
			{
				id: "wallet-auto-reload-failed",
				title: "Auto-reload failed",
				description:
					"We couldn’t charge your saved card. Review your payment method or top up manually.",
				badge: "Wallet",
				actionLabel: "Review Wallet",
				severity: "destructive",
			},
		];
	}

	if (wallet.auto_reload_status === "paused_monthly_limit") {
		return [
			{
				id: "wallet-auto-reload-cap",
				title: "Auto-reload monthly limit reached",
				description:
					"Auto-reload is paused for this period. Top up manually or review your monthly limit.",
				badge: "Wallet",
				actionLabel: "Review auto-reload",
				severity: "warning",
			},
		];
	}

	if (!state.low) return [];

	return [
		{
			id: "wallet-low-balance",
			title: "Your Wallet balance is running low",
			description: `You have about ${formatUsdExact(wallet.balance_usd)} left. Top up or turn on auto-reload before Wallet-backed services pause.`,
			badge: "Wallet",
			actionLabel: "Top up",
			severity: "warning",
		},
	];
}
