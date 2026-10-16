"use client";

import { billingCopy, lowBalanceBannerCopy, lowBalanceBannerView } from "@clawdi/shared/view";
import { AlertTriangle, CreditCard, Repeat } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { WalletCacheSnapshot } from "@/hosted/billing/wallet/wallet-cache";

/**
 * Low-balance / payment-attention banner.
 *
 * Shows when the managed-AI balance is low, or an auto-reload attempt needs
 * action (SCA) or was declined. Copy accounts for the shared balance funding
 * both Clawdi AI and wallet compute, and offers top-up / auto-reload links.
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
	wallet: WalletCacheSnapshot | undefined;
	hasWalletCompute?: boolean;
	onTopUp?: () => void;
	onAutoReload?: () => void;
}) {
	const view = lowBalanceBannerView(wallet, { hasWalletCompute, cardBilling: true });
	if (!wallet || !view) return null;
	const { hasAction, declined } = view;

	return (
		<Alert data-hosted="true" variant={view.tone}>
			<AlertTriangle />
			<AlertTitle>{view.title}</AlertTitle>
			<AlertDescription className="flex flex-col items-start gap-3">
				<span>{view.body}</span>
				<div className="flex flex-wrap gap-2">
					{/* A pending SCA / decline lives on the auto-reload card as an actual
					    confirm control — lead users there rather than to a new top-up. */}
					{hasAction && onAutoReload ? (
						<Button size="sm" onClick={onAutoReload}>
							<Repeat />{" "}
							{declined ? lowBalanceBannerCopy.retryPayment : lowBalanceBannerCopy.confirmPayment}
						</Button>
					) : onTopUp ? (
						<Button size="sm" onClick={onTopUp}>
							<CreditCard /> {billingCopy.topUp}
						</Button>
					) : null}
					{!hasAction && onAutoReload && !wallet.auto_reload_enabled ? (
						<Button size="sm" variant="outline" onClick={onAutoReload}>
							<Repeat /> {lowBalanceBannerCopy.setUpAutoReload}
						</Button>
					) : null}
				</div>
			</AlertDescription>
		</Alert>
	);
}
