"use client";

import { AlertTriangle, CreditCard, Repeat } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { lowBalanceBannerState } from "@/hosted/billing/components/low-balance-banner.logic";
import type { WalletState } from "@/hosted/billing/contracts";
import { creditsToUsd } from "@/hosted/billing/format";

/**
 * Low-balance / payment-attention banner.
 *
 * Shows when the managed-AI balance is low, or an auto-reload attempt needs
 * action (SCA) or was declined. Always leads with the reassuring narrative —
 * the agent keeps running; only managed AI pauses — and offers the top-up /
 * auto-reload deep links.
 *
 * Returns null when there's nothing to surface, so callers can render it
 * unconditionally at the top of any page.
 */
export function LowBalanceBanner({
	wallet,
	onTopUp,
	onAutoReload,
}: {
	wallet: WalletState | undefined;
	onTopUp?: () => void;
	onAutoReload?: () => void;
}) {
	const { show, hasAction, declined, needsAction } = lowBalanceBannerState(wallet);
	if (!wallet || !show) return null;

	const title = declined
		? "Auto-reload was declined"
		: needsAction
			? "Your bank needs to confirm a top-up"
			: "Your AI Credits are running low";

	const body = declined
		? "We couldn’t charge your saved card. Top up manually or update your payment method — your agent keeps running."
		: needsAction
			? "A top-up is waiting on confirmation from your bank. Managed AI may pause until it clears, but your agent keeps running."
			: `You have about ${creditsToUsd(wallet.balance_credits, wallet.points_per_usd)} of managed AI left. Top up or turn on auto-reload so it doesn’t pause — your agent keeps running either way.`;

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
