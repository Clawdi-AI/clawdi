"use client";

import { Coins, CreditCard, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { formatUsdExact } from "@/hosted/billing/format";
import type { WalletCacheSnapshot } from "@/hosted/billing/wallet/wallet-cache";
import { isLowBalance } from "@/hosted/billing/wallet/wallet-constants";

/**
 * Balance hero. When the balance trips the low threshold the figure goes
 * warning-toned and an inline chip explains the consequence for Clawdi AI
 * and wallet-funded compute.
 */
export function BalanceCard({
	wallet,
	hasWalletCompute = false,
	onTopUp,
	onManagePaymentMethods,
	isManagePaymentMethodsPending = false,
}: {
	wallet: WalletCacheSnapshot;
	hasWalletCompute?: boolean;
	onTopUp: () => void;
	onManagePaymentMethods: () => void;
	isManagePaymentMethodsPending?: boolean;
}) {
	const low = isLowBalance(wallet.balance_usd);
	return (
		<Card data-hosted="true">
			<CardContent className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
				<div className="space-y-1.5">
					<div className="flex items-center gap-1.5 text-sm text-muted-foreground">
						<Coins className="size-4" aria-hidden />
						Wallet balance
					</div>
					<div>
						<span
							className={
								low
									? "text-4xl font-semibold tracking-tight tabular-nums text-warning-muted-foreground"
									: "text-4xl font-semibold tracking-tight tabular-nums"
							}
						>
							{formatUsdExact(wallet.balance_usd)}
						</span>
					</div>
					<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
						<span>Pays for Clawdi AI and wallet-funded compute.</span>
						{low ? (
							<span className="inline-flex items-center gap-1 font-medium text-warning-muted-foreground">
								<TriangleAlert className="size-3.5" aria-hidden /> Low — top up before
								{hasWalletCompute ? " AI or compute is interrupted" : " Clawdi AI pauses"}
							</span>
						) : null}
					</div>
				</div>
				<div className="flex w-full flex-col gap-2 sm:flex-row lg:w-auto lg:shrink-0">
					<Button onClick={onTopUp} size="lg" className="w-full sm:w-auto">
						<CreditCard /> Top up
					</Button>
					<Button
						variant="outline"
						size="lg"
						className="w-full sm:w-auto"
						onClick={onManagePaymentMethods}
						disabled={isManagePaymentMethodsPending}
						aria-busy={isManagePaymentMethodsPending}
					>
						{isManagePaymentMethodsPending ? <Spinner /> : <CreditCard />} Manage payment methods
					</Button>
				</div>
			</CardContent>
		</Card>
	);
}
