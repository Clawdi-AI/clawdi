"use client";

import { PageHeader } from "@/components/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { BillingEmpty, BillingError } from "@/hosted/billing/components/state-views";
import { isWalletNotEnabledError } from "@/hosted/billing/errors";
import { useWallet } from "@/hosted/billing/hooks";
import { RedeemCard } from "@/hosted/billing/rewards/redeem-card";
import { ReferralCard } from "@/hosted/billing/rewards/referral-card";

const DESCRIPTION = "Redeem codes and refer friends to earn AI Credits and Performance time.";

export function RewardsPage() {
	const wallet = useWallet();

	if (wallet.isLoading) {
		return (
			<div data-hosted="true" className="space-y-6 px-4 lg:px-6">
				<PageHeader title="Rewards" description={DESCRIPTION} />
				<div className="grid items-start gap-4 lg:grid-cols-2">
					<Skeleton className="h-64 w-full rounded-lg" />
					<Skeleton className="h-64 w-full rounded-lg" />
				</div>
			</div>
		);
	}

	if (isWalletNotEnabledError(wallet.error)) {
		return (
			<div data-hosted="true" className="space-y-6 px-4 lg:px-6">
				<PageHeader title="Rewards" description={DESCRIPTION} />
				<BillingEmpty
					title="Rewards aren’t enabled"
					description="This account uses the classic plan model."
				/>
			</div>
		);
	}

	if (wallet.error || !wallet.data) {
		return (
			<div data-hosted="true" className="space-y-6 px-4 lg:px-6">
				<PageHeader title="Rewards" description={DESCRIPTION} />
				<BillingError error={wallet.error} onRetry={() => wallet.refetch()} />
			</div>
		);
	}

	return (
		<div data-hosted="true" className="space-y-6 px-4 lg:px-6">
			<PageHeader title="Rewards" description={DESCRIPTION} />
			<div className="grid items-start gap-4 lg:grid-cols-2">
				<RedeemCard />
				<ReferralCard />
			</div>
		</div>
	);
}
