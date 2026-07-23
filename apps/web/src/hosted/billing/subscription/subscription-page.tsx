"use client";

import { Link } from "@tanstack/react-router";
import { CreditCard, Rocket } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { PageHeader } from "@/components/page-header";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { SubscriptionSkeleton } from "@/hosted/billing/components/state-views";
import { billingErrorNormalizer, normalizeBillingError } from "@/hosted/billing/errors";
import { usePlans, usePortal } from "@/hosted/billing/hooks";
import { BillingHistorySection } from "@/hosted/billing/subscription/billing-history-section";
import { PlanComparison } from "@/hosted/billing/subscription/plan-comparison";
import { WelcomeCreditsCard } from "@/hosted/billing/subscription/welcome-credits-card";
import { useActionLock } from "@/hosted/billing/use-action-lock";
import { useHostedProductAccess } from "@/lib/hosted-product-access";
import { cn } from "@/lib/utils";

const DESCRIPTION =
	"Plan options for new hosted agents. Existing compute is managed from each agent’s Settings.";
const SUBSCRIPTION_PAGE_CLASS = cn(
	CENTERED_PAGE_WIDTH_CLASS.page,
	"flex flex-col gap-6 px-4 lg:px-6",
);

export function SubscriptionPage() {
	const plans = usePlans();
	const portal = usePortal();
	const hostedAccess = useHostedProductAccess();
	const runAction = useActionLock();
	const [term, setTerm] = useState(1);

	async function openBillingPortal() {
		try {
			const res = await portal.mutateAsync({});
			if (res.url || res.portal_url) {
				window.location.href = res.url || res.portal_url;
				return;
			}
			toast.message("Billing portal unavailable", {
				description: "Refresh this page and try again in a moment.",
			});
		} catch (e) {
			toast.error("Couldn’t open billing", { description: normalizeBillingError(e) });
		}
	}

	if (plans.isLoading) {
		return (
			<div data-hosted="true" className={SUBSCRIPTION_PAGE_CLASS}>
				<PageHeader title="Compute" description={DESCRIPTION} />
				<SubscriptionSkeleton />
			</div>
		);
	}

	if (plans.error) {
		return (
			<div data-hosted="true" className={SUBSCRIPTION_PAGE_CLASS}>
				<PageHeader title="Compute" description={DESCRIPTION} />
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
			<PageHeader title="Compute" description={DESCRIPTION} />

			<WelcomeCreditsCard />

			<Card data-hosted="true">
				<CardHeader>
					<CardTitle>Compute is managed per agent</CardTitle>
					<CardDescription>
						Basic includes one free active hosted-agent slot. Additional Basic and Performance
						agents each use a separate subscription.
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-4">
					<p className="text-sm text-muted-foreground">
						Upgrade, lifecycle, and delete controls live in that agent’s Settings page. Wallet
						balance and managed-AI usage stay account-wide.
					</p>
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
				</CardContent>
			</Card>

			<BillingHistorySection />

			<PlanComparison
				term={term}
				onTermChange={setTerm}
				canCreateCloudAgents={hostedAccess.canCreateCloudAgents}
			/>
		</div>
	);
}
