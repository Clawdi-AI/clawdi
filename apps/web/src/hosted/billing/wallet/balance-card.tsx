"use client";

import { Coins, CreditCard, Info, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { WalletState } from "@/hosted/billing/contracts";
import { creditsToUsd, formatCredits } from "@/hosted/billing/format";
import { isLowBalance } from "@/hosted/billing/wallet/wallet-constants";
import { relativeTime } from "@/lib/utils";

/**
 * Balance hero. The dollar figure is the loudest thing on the wallet page; the
 * credits and conversion rate sit underneath as supporting context. When the
 * balance trips the low threshold the figure goes warning-toned and an inline
 * chip explains the consequence (managed AI pauses, the agent keeps running).
 */
export function BalanceCard({ wallet, onTopUp }: { wallet: WalletState; onTopUp: () => void }) {
	const low = isLowBalance(wallet.balance_credits, wallet.points_per_usd);
	return (
		<Card data-hosted="true">
			<CardContent className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
				<div className="space-y-1.5">
					<div className="flex items-center gap-1.5 text-sm text-muted-foreground">
						<Coins className="size-4" aria-hidden />
						AI Credits balance
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
								A snapshot of your managed-AI balance. It can lag actual usage by a few seconds.
							</TooltipContent>
						</Tooltip>
					</div>
					<div className="flex items-baseline gap-2">
						<span
							className={
								low
									? "text-4xl font-semibold tracking-tight tabular-nums text-warning-muted-foreground"
									: "text-4xl font-semibold tracking-tight tabular-nums"
							}
						>
							{creditsToUsd(wallet.balance_credits, wallet.points_per_usd)}
						</span>
						<span className="text-sm text-muted-foreground tabular-nums">
							{formatCredits(wallet.balance_credits)}
						</span>
					</div>
					<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
						<span className="tabular-nums">
							$1 = {wallet.points_per_usd.toLocaleString()} credits
						</span>
						<span aria-hidden>·</span>
						<span>
							{wallet.balance_snapshot_at
								? `Snapshot ${relativeTime(wallet.balance_snapshot_at)}`
								: "Awaiting first balance snapshot…"}
						</span>
						{low ? (
							<span className="inline-flex items-center gap-1 font-medium text-warning-muted-foreground">
								<TriangleAlert className="size-3.5" aria-hidden /> Low — top up so managed AI
								doesn’t pause
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
