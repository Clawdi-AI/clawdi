"use client";

import { AlertTriangle, CreditCard, Repeat } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { lowBalanceBannerState } from "@/hosted/billing/components/low-balance-banner.logic";
import type { WalletState } from "@/hosted/billing/contracts";
import { formatUsdExact } from "@/hosted/billing/format";

/**
 * Low-balance / payment-attention banner.
 *
 * Shows when the managed-AI balance is low, or an auto-reload attempt needs
 * action (SCA) or was declined. Copy accounts for the shared balance funding
 * both managed AI and wallet compute, and offers top-up / auto-reload links.
 *
 * Returns null when there's nothing to surface, so callers can render it
 * unconditionally at the top of any page.
 */
export function LowBalanceBanner({
	wallet,
	hasWalletCompute = false,
	onTopUp,
	onAutoReload,
}: {
	wallet: WalletState | undefined;
	hasWalletCompute?: boolean;
	onTopUp?: () => void;
	onAutoReload?: () => void;
}) {
	const { show, hasAction, declined, needsAction } = lowBalanceBannerState(wallet);
	if (!wallet || !show) return null;

	const title = declined
		? "Auto-reload was declined"
		: needsAction
			? "Your bank needs to confirm a top-up"
			: "Your Wallet balance is running low";

	const consequence = hasWalletCompute
		? "Managed AI and wallet-funded compute can be interrupted if the balance stays low."
		: "Managed AI can pause if the balance stays low.";
	const body = declined
		? `We couldn’t charge your saved card. Top up manually or update your payment method. ${consequence}`
		: needsAction
			? `A top-up is waiting on confirmation from your bank. ${consequence}`
			: `You have about ${formatUsdExact(wallet.balance_usd)} left. Top up or turn on auto-reload. ${consequence}`;

	return (
		<Alert data-hosted="true" variant={declined ? "destructive" : "default"}>
			<AlertTriangle />
			<AlertTitle>{title}</AlertTitle>
			<AlertDescription className="flex flex-col items-start gap-3">
				<span>{body}</span>
				<div className="flex flex-wrap gap-2">
					{/* A pending SCA / decline lives on the auto-reload card as an actual
					    confirm control — lead users there rather than to a new top-up. */}
					{hasAction && onAutoReload ? (
						<Button size="sm" onClick={onAutoReload}>
							<Repeat /> {declined ? "Retry payment" : "Confirm payment"}
						</Button>
					) : onTopUp ? (
						<Button size="sm" onClick={onTopUp}>
							<CreditCard /> Top up
						</Button>
					) : null}
					{!hasAction && onAutoReload && !wallet.auto_reload_enabled ? (
						<Button size="sm" variant="outline" onClick={onAutoReload}>
							<Repeat /> Set up auto-reload
						</Button>
					) : null}
				</div>
			</AlertDescription>
		</Alert>
	);
}
