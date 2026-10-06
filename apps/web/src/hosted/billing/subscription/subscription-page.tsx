"use client";

import { billingPageClass } from "@clawdi/shared/ui";
import type { AgentTile } from "@clawdi/shared/view";
import { billingCopy } from "@clawdi/shared/view";
import { useState } from "react";
import { SettingsPanelHeader } from "@/components/settings/settings-panel-header";
import { PlanComparison } from "@/hosted/billing/subscription/plan-comparison";
import { SubscriptionsSection } from "@/hosted/billing/subscription/subscriptions-section";

const DESCRIPTION = billingCopy.computeDescription;
const SUBSCRIPTION_PAGE_CLASS = billingPageClass;

export function SubscriptionPage({ agentTiles }: { agentTiles: readonly AgentTile[] }) {
	const [term, setTerm] = useState(1);

	return (
		<div data-hosted="true" className={SUBSCRIPTION_PAGE_CLASS}>
			<SettingsPanelHeader title={billingCopy.compute} description={DESCRIPTION} />

			<SubscriptionsSection agentTiles={agentTiles} />

			<PlanComparison term={term} onTermChange={setTerm} />
		</div>
	);
}
