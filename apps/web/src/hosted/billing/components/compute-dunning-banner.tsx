"use client";

import {
	CreditCard,
	ExternalLink,
	History,
	Info,
	LifeBuoy,
	Plus,
	TriangleAlert,
	WalletCards,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { HostedDeployment } from "@/hosted/billing/contracts";
import { normalizeBillingError } from "@/hosted/billing/errors";
import { useFixPayment, useWallet } from "@/hosted/billing/hooks";
import { useActionLock } from "@/hosted/billing/use-action-lock";
import { TopUpDialog } from "@/hosted/billing/wallet/top-up-dialog";
import { formatShortDate } from "@/lib/format";
import { useHostedProductAccess } from "@/lib/hosted-product-access";
import { settingsQueryHref } from "@/lib/settings-routes";
import { computeDunningState, fallbackReasonSentence } from "./compute-dunning.logic";

export function ComputeDunningBanner({ deployment }: { deployment: HostedDeployment }) {
	const state = computeDunningState(deployment);
	const hostedAccess = useHostedProductAccess();
	const fixPayment = useFixPayment();
	const runAction = useActionLock();
	const wallet = useWallet({
		enabled: state?.ctaTarget === "top_up",
	});
	const [topUpOpen, setTopUpOpen] = useState(false);

	if (!state) return null;

	const destructive = state.tone === "destructive";
	const bannerDescription = [
		state.fallbackOccurredAt && state.fallbackPlanLabel && state.fallbackReason
			? fallbackReasonSentence(
					state.fallbackReason,
					state.fallbackPlanLabel,
					formatShortDate(state.fallbackOccurredAt),
				)
			: null,
		state.description,
	]
		.filter(Boolean)
		.join(" ");

	async function handleFixPayment() {
		if (!state) return;
		if (state.ctaTarget === "invoice" && state.invoiceUrl) {
			window.location.href = state.invoiceUrl;
			return;
		}
		try {
			const result = await fixPayment.mutateAsync({ deployment_id: deployment.resource.id });
			const url = result.url || result.portal_url;
			if (url) {
				window.location.href = url;
				return;
			}
			toast.message("Payment update unavailable", {
				description: "Refresh this page and try again in a moment.",
			});
		} catch (error) {
			toast.error("Couldn’t open payment settings", {
				description: normalizeBillingError(error),
			});
		}
	}

	const BannerIcon = state.tone === "neutral" ? Info : TriangleAlert;

	return (
		<>
			<Alert
				data-hosted="true"
				variant={destructive ? "destructive" : "default"}
				className={
					destructive
						? undefined
						: state.tone === "warning"
							? "border-warning/30 bg-warning-muted"
							: "border-info-muted bg-info-muted text-info-muted-foreground"
				}
			>
				<BannerIcon aria-hidden />
				<AlertTitle>{state.title}</AlertTitle>
				<AlertDescription className="flex flex-col items-start gap-3">
					<span>{bannerDescription}</span>
					{hostedAccess.isLoading ? null : !hostedAccess.canCreateCloudAgents &&
						state.ctaTarget === "start_new" ? (
						<span className="text-xs text-muted-foreground">
							Starting a new subscription is temporarily unavailable. This deployment remains
							visible and manageable.
						</span>
					) : state.ctaTarget === "top_up" ? (
						<Button
							size="sm"
							variant={destructive ? "destructive" : "default"}
							onClick={() => setTopUpOpen(true)}
							disabled={!wallet.data}
						>
							<WalletCards data-icon="inline-start" /> Top up
						</Button>
					) : state.ctaTarget === "start_new" ? (
						<Button
							render={<a href="#compute-plan-controls" />}
							nativeButton={false}
							size="sm"
							variant={destructive ? "destructive" : "default"}
						>
							<Plus data-icon="inline-start" /> Start a new subscription
						</Button>
					) : state.ctaTarget === "billing_history" ? (
						<Button
							render={<a href={settingsQueryHref("billing-plan")} />}
							nativeButton={false}
							size="sm"
							variant="outline"
						>
							<History data-icon="inline-start" /> View billing history
						</Button>
					) : state.ctaTarget === "support" ? (
						<Button
							render={<a href="mailto:support@clawdi.ai" />}
							nativeButton={false}
							size="sm"
							variant="outline"
						>
							<LifeBuoy data-icon="inline-start" /> Contact support
						</Button>
					) : state.ctaTarget === "invoice" || state.ctaTarget === "fix_payment" ? (
						<Button
							size="sm"
							variant={destructive ? "destructive" : "default"}
							onClick={() => void runAction(handleFixPayment)}
							disabled={fixPayment.isPending}
						>
							{fixPayment.isPending ? (
								<Spinner data-icon="inline-start" />
							) : state.ctaTarget === "invoice" ? (
								<ExternalLink data-icon="inline-start" />
							) : (
								<CreditCard data-icon="inline-start" />
							)}
							Fix payment
						</Button>
					) : null}
					{state.secondaryTarget === "billing_history" ? (
						<Button
							render={<a href={settingsQueryHref("billing-plan")} />}
							nativeButton={false}
							size="sm"
							variant="outline"
						>
							<History data-icon="inline-start" /> View billing history
						</Button>
					) : state.secondaryTarget === "support" ? (
						<Button
							render={<a href="mailto:support@clawdi.ai" />}
							nativeButton={false}
							size="sm"
							variant="outline"
						>
							<LifeBuoy data-icon="inline-start" /> Contact support
						</Button>
					) : null}
				</AlertDescription>
			</Alert>
			{wallet.data ? (
				<TopUpDialog open={topUpOpen} onOpenChange={setTopUpOpen} wallet={wallet.data} />
			) : null}
		</>
	);
}
