"use client";

import { balanceCardClasses } from "@clawdi/shared/ui";
import { billingCopy } from "@clawdi/shared/view";
import { Coins, CreditCard, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatUsdExact } from "@/hosted/billing/format";
import type { WalletCacheSnapshot } from "@/hosted/billing/wallet/wallet-cache";
import { isLowBalance } from "@/hosted/billing/wallet/wallet-constants";

/**
 * Balance hero. When the balance trips the low threshold the figure goes
 * warning-toned and an inline chip explains the consequence for AI usage
 * and wallet-funded compute.
 */
export function BalanceCard({
	wallet,
	hasWalletCompute = false,
	onTopUp,
}: {
	wallet: WalletCacheSnapshot;
	hasWalletCompute?: boolean;
	onTopUp: () => void;
}) {
	const low = isLowBalance(wallet.balance_usd);
	return (
		<Card data-hosted="true">
			<CardContent className={balanceCardClasses.layout}>
				<div className={balanceCardClasses.copy}>
					<div className={balanceCardClasses.label}>
						<Coins className={balanceCardClasses.icon} aria-hidden />
						{billingCopy.walletBalance}
					</div>
					<div>
						<span className={low ? balanceCardClasses.negativeBalance : balanceCardClasses.balance}>
							{formatUsdExact(wallet.balance_usd)}
						</span>
					</div>
					<div className={balanceCardClasses.meta}>
						<span>{billingCopy.walletExplanation}</span>
						{low ? (
							<span className={balanceCardClasses.warning}>
								<TriangleAlert className={balanceCardClasses.warningIcon} aria-hidden /> Low — top
								up before
								{hasWalletCompute ? " AI or compute is interrupted" : " Clawdi AI pauses"}
							</span>
						) : null}
					</div>
				</div>
				<div className={balanceCardClasses.actions}>
					<Button onClick={onTopUp} className={balanceCardClasses.action}>
						<CreditCard /> Top up
					</Button>
				</div>
			</CardContent>
		</Card>
	);
}
