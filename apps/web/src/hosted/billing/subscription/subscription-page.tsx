"use client";

import { Link } from "@tanstack/react-router";
import { CreditCard, Rocket } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { SettingsPanelHeader } from "@/components/settings/settings-panel-header";
import { SettingsSection } from "@/components/settings-section";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { normalizeBillingError } from "@/hosted/billing/errors";
import { useSensitiveBillingPortal } from "@/hosted/billing/sensitive-actions";
import { BillingHistorySection } from "@/hosted/billing/subscription/billing-history-section";
import { PlanComparison } from "@/hosted/billing/subscription/plan-comparison";
import { SubscriptionsSection } from "@/hosted/billing/subscription/subscriptions-section";
import { useActionLock } from "@/hosted/billing/use-action-lock";
import { useHostedProductAccess } from "@/lib/hosted-product-access";

const DESCRIPTION = "Subscriptions, plans, and account billing for hosted agents.";
const SUBSCRIPTION_PAGE_CLASS = "flex flex-col gap-8 px-5 sm:px-6 lg:px-8";

export function SubscriptionPage() {
	const portal = useSensitiveBillingPortal();
	const hostedAccess = useHostedProductAccess();
	const runAction = useActionLock();
	const [term, setTerm] = useState(1);

	async function openBillingPortal() {
		try {
			const res = await portal.execute({});
			if (res.url || res.portal_url) {
				window.location.href = res.url || res.portal_url;
				return;
			}
			toast.error("Billing portal unavailable", {
				description: "Refresh this page and try again in a moment.",
			});
		} catch (e) {
			toast.error("Couldn’t open billing", { description: normalizeBillingError(e) });
		}
	}

	return (
		<div data-hosted="true" className={SUBSCRIPTION_PAGE_CLASS}>
			<SettingsPanelHeader title="Compute" description={DESCRIPTION} />

			<SubscriptionsSection
				actions={
					<Button
						variant="outline"
						size="sm"
						onClick={() => runAction(openBillingPortal)}
						disabled={portal.isPending}
					>
						{portal.isPending ? <Spinner /> : <CreditCard />} Open billing portal
					</Button>
				}
			/>

			<SettingsSection
				headingLevel={3}
				title="Start a new agent"
				description="Choose a compute plan and deploy another hosted agent."
			>
				{hostedAccess.canCreateCloudAgents ? (
					<Button render={<Link to="/deploy" />} nativeButton={false}>
						<Rocket /> Deploy hosted agent
					</Button>
				) : (
					<Button disabled>
						<Rocket /> Deploy hosted agent
					</Button>
				)}
			</SettingsSection>

			<PlanComparison term={term} onTermChange={setTerm} />

			<BillingHistorySection />
		</div>
	);
}
