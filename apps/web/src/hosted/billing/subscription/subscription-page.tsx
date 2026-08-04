"use client";

import { Link } from "@tanstack/react-router";
import { CreditCard, Rocket } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { SettingsPanelHeader } from "@/components/settings/settings-panel-header";
import { SettingsSection } from "@/components/settings-section";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { SubscriptionSkeleton } from "@/hosted/billing/components/state-views";
import { billingErrorNormalizer, normalizeBillingError } from "@/hosted/billing/errors";
import { usePlans } from "@/hosted/billing/hooks";
import { useSensitiveBillingPortal } from "@/hosted/billing/sensitive-actions";
import { BillingHistorySection } from "@/hosted/billing/subscription/billing-history-section";
import { PlanComparison } from "@/hosted/billing/subscription/plan-comparison";
import { WelcomeWalletCard } from "@/hosted/billing/subscription/welcome-wallet-card";
import { useActionLock } from "@/hosted/billing/use-action-lock";
import { useHostedProductAccess } from "@/lib/hosted-product-access";
import { shouldBlockQueryError } from "@/lib/query-state";

const DESCRIPTION =
	"Plan options for new hosted agents. Existing compute is managed from each agent’s Settings.";
const SUBSCRIPTION_PAGE_CLASS = "flex flex-col gap-8 px-4 lg:px-6";

export function SubscriptionPage() {
	const plans = usePlans();
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

	if (plans.isLoading) {
		return (
			<div data-hosted="true" className={SUBSCRIPTION_PAGE_CLASS}>
				<SettingsPanelHeader title="Compute" description={DESCRIPTION} />
				<SubscriptionSkeleton />
			</div>
		);
	}

	if (shouldBlockQueryError(plans.error, plans.data)) {
		return (
			<div data-hosted="true" className={SUBSCRIPTION_PAGE_CLASS}>
				<SettingsPanelHeader title="Compute" description={DESCRIPTION} />
				<ApiErrorPanel
					normalizer={billingErrorNormalizer}
					error={plans.error}
					onRetry={() => plans.refetch()}
					title="Couldn’t load plans"
				/>
			</div>
		);
	}

	return (
		<div data-hosted="true" className={SUBSCRIPTION_PAGE_CLASS}>
			<SettingsPanelHeader title="Compute" description={DESCRIPTION} />

			<WelcomeWalletCard />

			<SettingsSection
				headingLevel={3}
				title="Manage compute"
				description="Deploy a new hosted agent here. Manage existing plans from each agent’s Settings."
			>
				<div className="flex flex-wrap gap-2">
					{hostedAccess.canCreateCloudAgents ? (
						<Button render={<Link to="/deploy" />} nativeButton={false}>
							<Rocket /> Deploy hosted agent
						</Button>
					) : (
						<Button disabled>
							<Rocket /> Deploy hosted agent
						</Button>
					)}
					<Button
						variant="outline"
						onClick={() => runAction(openBillingPortal)}
						disabled={portal.isPending}
					>
						{portal.isPending ? <Spinner /> : <CreditCard />} Open billing portal
					</Button>
				</div>
			</SettingsSection>

			<BillingHistorySection />

			<PlanComparison
				term={term}
				onTermChange={setTerm}
				canCreateCloudAgents={hostedAccess.canCreateCloudAgents}
			/>
		</div>
	);
}
