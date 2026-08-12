"use client";

import { useState } from "react";
import { SettingsPanelHeader } from "@/components/settings/settings-panel-header";
import { PlanComparison } from "@/hosted/billing/subscription/plan-comparison";
import { SubscriptionsSection } from "@/hosted/billing/subscription/subscriptions-section";

const DESCRIPTION = "Subscriptions, plans, and account billing for hosted agents.";
const SUBSCRIPTION_PAGE_CLASS = "flex flex-col gap-8 px-5 sm:px-6 lg:px-8";

export function SubscriptionPage() {
	const [term, setTerm] = useState(1);

	return (
		<div data-hosted="true" className={SUBSCRIPTION_PAGE_CLASS}>
			<SettingsPanelHeader title="Compute" description={DESCRIPTION} />

			<SubscriptionsSection />

			<PlanComparison term={term} onTermChange={setTerm} />
		</div>
	);
}
