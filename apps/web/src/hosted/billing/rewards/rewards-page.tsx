"use client";

import { Gift } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { BillingEmpty } from "@/hosted/billing/components/state-views";

const DESCRIPTION = "Hosted billing rewards.";

export function RewardsPage() {
	return (
		<div data-hosted="true" className="space-y-6 px-4 lg:px-6">
			<PageHeader title="Rewards" description={DESCRIPTION} />
			<BillingEmpty
				icon={<Gift />}
				title="Rewards aren’t available yet"
				description="Referral rewards and redemption codes are not connected to v2 billing yet."
			/>
		</div>
	);
}
