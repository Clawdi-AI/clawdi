"use client";

import { Link2 } from "lucide-react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { SettingsSection } from "@/components/settings-section";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { billingErrorNormalizer } from "@/hosted/billing/errors";
import { useHostedUser } from "@/hosted/billing/hooks";
import { shouldBlockQueryError } from "@/lib/query-state";

export function X402Card({ enabled }: { enabled: boolean }) {
	if (!enabled) {
		return (
			<SettingsSection
				headingLevel={3}
				data-hosted="true"
				title={
					<span className="flex flex-wrap items-center gap-2">
						<span className="inline-flex items-center gap-2">
							<Link2 className="size-4" aria-hidden /> USDC via x402
						</span>
						<Badge variant="secondary">Not available yet</Badge>
					</span>
				}
				description="x402 payments are not available yet. When launched, agents will be able to add Wallet funds with USDC."
			/>
		);
	}

	return <EnabledX402Card />;
}

function EnabledX402Card() {
	const me = useHostedUser();
	const address = me.data?.evm_wallet_address ?? null;

	return (
		<SettingsSection
			headingLevel={3}
			data-hosted="true"
			title={
				<span className="flex flex-wrap items-center gap-2">
					<span className="inline-flex items-center gap-2">
						<Link2 className="size-4" aria-hidden /> USDC via x402
					</span>
					<Badge variant="outline">Available</Badge>
				</span>
			}
			description="Your agent can add Wallet funds from its linked wallet using USDC."
		>
			<div className="max-w-2xl">
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
			</div>
		</SettingsSection>
	);
}
