"use client";

import { Link2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { CopyButton } from "@/hosted/billing/components/copy-button";
import { BillingError } from "@/hosted/billing/components/state-views";
import { useHostedUser } from "@/hosted/billing/hooks";

/**
 * x402 self-funding block. Agents can top up their own wallet on-chain via the
 * x402 protocol; this surfaces the deposit address and a short explainer.
 */
export function X402Card() {
	const me = useHostedUser();
	const address = me.data?.evm_wallet_address ?? null;

	return (
		<Card data-hosted="true">
			<CardHeader>
				<CardTitle className="flex items-center gap-2 text-base">
					<Link2 className="size-4" aria-hidden /> On-chain top-up (x402)
				</CardTitle>
				<CardDescription>
					Your agent can fund its own AI Credits on-chain via the x402 protocol — no card needed.
					Deposits land in the same wallet balance.
				</CardDescription>
			</CardHeader>
			<CardContent>
				{me.isLoading ? (
					<Skeleton className="h-9 w-full rounded-md" />
				) : me.error ? (
					<BillingError
						error={me.error}
						onRetry={() => me.refetch()}
						title="Couldn’t load deposit address"
					/>
				) : address ? (
					<div className="space-y-1.5">
						<span className="text-xs text-muted-foreground">Deposit address</span>
						<div className="flex items-center gap-2 rounded-md border bg-muted/30 p-2">
							<code className="min-w-0 flex-1 truncate font-mono text-xs">{address}</code>
							<CopyButton
								value={address}
								label="Copy deposit address"
								toastMessage="Address copied"
							/>
						</div>
					</div>
				) : (
					<p className="text-sm text-muted-foreground">
						An on-chain deposit address is provisioned with your first managed-AI agent.
					</p>
				)}
			</CardContent>
		</Card>
	);
}
