"use client";

import { LifeBuoy, Link2, TriangleAlert } from "lucide-react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { billingErrorNormalizer } from "@/hosted/billing/errors";
import { useHostedUser } from "@/hosted/billing/hooks";
import { shouldBlockQueryError } from "@/lib/query-state";

/**
 * x402 self-funding block. Agents can top up their own wallet on-chain via the
 * x402 protocol; this surfaces the deposit address and a short explainer.
 * WalletPage mounts this only when the wallet snapshot reports x402 enabled.
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
					Your agent can add USD value on-chain via the x402 protocol — no card needed. Deposits
					land in the same wallet balance.
				</CardDescription>
			</CardHeader>
			<CardContent>
				{me.isLoading ? (
					<Skeleton className="h-9 w-full rounded-md" />
				) : shouldBlockQueryError(me.error, me.data) ? (
					<ApiErrorPanel
						normalizer={billingErrorNormalizer}
						error={me.error}
						onRetry={() => me.refetch()}
						title="Couldn’t load deposit address"
					/>
				) : address ? (
					<Alert variant="destructive">
						<TriangleAlert aria-hidden />
						<AlertTitle>Contact support for deposit details</AlertTitle>
						<AlertDescription className="flex flex-col items-start gap-3">
							<span>
								Your account data does not identify the required network or accepted token, so the
								deposit address is hidden for your safety. Funds sent on the wrong network or as the
								wrong token are unrecoverable.
							</span>
							<Button
								render={<a href="mailto:support@clawdi.ai" />}
								nativeButton={false}
								size="sm"
								variant="outline"
							>
								<LifeBuoy data-icon="inline-start" /> Contact support
							</Button>
						</AlertDescription>
					</Alert>
				) : (
					<p className="text-sm text-muted-foreground">
						An on-chain deposit address is provisioned with your first Clawdi AI agent.
					</p>
				)}
			</CardContent>
		</Card>
	);
}
