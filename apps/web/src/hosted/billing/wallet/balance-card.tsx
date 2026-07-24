"use client";

import { Coins, CreditCard, Info, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { WalletState } from "@/hosted/billing/contracts";
import { formatUsdExact } from "@/hosted/billing/format";
import { isLowBalance } from "@/hosted/billing/wallet/wallet-constants";

/**
 * Balance hero. When the balance trips the low threshold the figure goes
 * warning-toned and an inline chip explains the consequence for managed AI
 * and wallet-funded compute.
 */
export function BalanceCard({
	wallet,
	hasWalletCompute = false,
	onTopUp,
}: {
	wallet: WalletState;
	hasWalletCompute?: boolean;
	onTopUp: () => void;
}) {
	const low = isLowBalance(wallet.balance_usd);
	return (
		<Card data-hosted="true">
			<CardContent className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
				<div className="space-y-1.5">
					<div className="flex items-center gap-1.5 text-sm text-muted-foreground">
						<Coins className="size-4" aria-hidden />
						Wallet balance
						<Tooltip>
							<TooltipTrigger
								render={
									<button
										type="button"
										aria-label="About this balance"
										className="rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
									/>
								}
							>
								<Info className="size-3.5" />
							</TooltipTrigger>
							<TooltipContent className="max-w-xs">
								One USD balance shared by managed AI and wallet-funded compute.
							</TooltipContent>
						</Tooltip>
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
						<span>Shared across managed AI and wallet-funded compute.</span>
						{low ? (
							<span className="inline-flex items-center gap-1 font-medium text-warning-muted-foreground">
								<TriangleAlert className="size-3.5" aria-hidden /> Low — top up before
								{hasWalletCompute ? " AI or compute is interrupted" : " managed AI pauses"}
							</span>
						) : null}
					</div>
				</div>
				<Button onClick={onTopUp} size="lg" className="w-full sm:w-auto">
					<CreditCard /> Top up
				</Button>
			</CardContent>
		</Card>
	);
}
