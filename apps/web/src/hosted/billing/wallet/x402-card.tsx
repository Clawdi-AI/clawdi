"use client";

import { Link2 } from "lucide-react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { billingErrorNormalizer } from "@/hosted/billing/errors";
import { useHostedUser } from "@/hosted/billing/hooks";
import { shouldBlockQueryError } from "@/lib/query-state";

export function X402Card({ enabled }: { enabled: boolean }) {
	if (!enabled) {
		return (
			<Card data-hosted="true" className="self-start">
				<CardHeader>
					<div className="flex items-center justify-between gap-3">
						<CardTitle className="flex items-center gap-2 text-base">
							<Link2 className="size-4" aria-hidden /> USDC top-up
						</CardTitle>
						<Badge variant="secondary">Coming soon</Badge>
					</div>
					<CardDescription>Let your agent add funds with USDC through x402.</CardDescription>
				</CardHeader>
			</Card>
		);
	}

	return <EnabledX402Card />;
}

function EnabledX402Card() {
	const me = useHostedUser();
	const address = me.data?.evm_wallet_address ?? null;

	return (
		<Card data-hosted="true" className="self-start">
			<CardHeader>
				<div className="flex items-center justify-between gap-3">
					<CardTitle className="flex items-center gap-2 text-base">
						<Link2 className="size-4" aria-hidden /> USDC top-up
					</CardTitle>
					<Badge variant="outline">x402</Badge>
				</div>
				<CardDescription>
					Your agent can add funds from its linked wallet. They appear in this balance.
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
						title="Couldn’t load linked wallet"
					/>
				) : address ? (
					<div className="space-y-1.5">
						<p className="text-xs text-muted-foreground">Linked agent wallet</p>
						<p className="break-all font-mono text-sm">{address}</p>
						<p className="text-xs text-muted-foreground">Top-ups must be signed by this wallet.</p>
					</div>
				) : (
					<p className="text-sm text-muted-foreground">
						Connect an agent wallet before using x402.
					</p>
				)}
			</CardContent>
		</Card>
	);
}
