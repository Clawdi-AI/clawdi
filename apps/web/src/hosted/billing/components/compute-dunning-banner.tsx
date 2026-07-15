"use client";

import { CreditCard, ExternalLink, RefreshCw, TriangleAlert, WalletCards } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { HostedDeployment } from "@/hosted/billing/contracts";
import { BillingApiError, normalizeBillingError } from "@/hosted/billing/errors";
import { useFixPayment, useRetryWalletCompute, useWallet } from "@/hosted/billing/hooks";
import { TopUpDialog } from "@/hosted/billing/wallet/top-up-dialog";
import { formatShortDate } from "@/lib/format";
import {
	collectionFailureMessage,
	computeDunningState,
	dunningDeadlineCountdown,
} from "./compute-dunning.logic";

export function ComputeDunningBanner({ deployment }: { deployment: HostedDeployment }) {
	const state = computeDunningState(deployment);
	const fixPayment = useFixPayment();
	const retryWallet = useRetryWalletCompute();
	const wallet = useWallet({ enabled: state?.ctaTarget === "wallet" });
	const [topUpOpen, setTopUpOpen] = useState(false);
	const [now, setNow] = useState(() => Date.now());

	useEffect(() => {
		if (!state?.serviceRiskAt || state.ctaTarget !== "wallet") return;
		const interval = window.setInterval(() => setNow(Date.now()), 60_000);
		return () => window.clearInterval(interval);
	}, [state?.ctaTarget, state?.serviceRiskAt]);

	if (!state) return null;

	const countdown =
		state.ctaTarget === "wallet" ? dunningDeadlineCountdown(state.serviceRiskAt, now) : null;
	const riskLabel = countdown
		? `Grace deadline: ${formatShortDate(state.serviceRiskAt)} (${countdown}).`
		: state.nextPaymentAttemptAt
			? `Next retry: ${formatShortDate(state.nextPaymentAttemptAt)}.`
			: state.serviceRiskAt && state.paymentState !== "unpaid"
				? `Service is at risk after ${formatShortDate(state.serviceRiskAt)}.`
				: null;
	const destructive = state.paymentState === "unpaid";
	const bannerDescription = [
		state.fallbackOccurredAt && state.fallbackPlanLabel
			? `This agent fell back from ${state.fallbackPlanLabel} because payment failed on ${formatShortDate(state.fallbackOccurredAt)}.`
			: null,
		state.description,
		collectionFailureMessage(state.failureCode),
		riskLabel,
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
			const res = await fixPayment.mutateAsync({ deployment_id: deployment.id });
			const url = res.url || res.portal_url;
			if (url) {
				window.location.href = url;
				return;
			}
			toast.message("Payment update unavailable", {
				description: res.message ?? "Please try again in a moment.",
			});
		} catch (error) {
			toast.error("Couldn’t open payment settings", {
				description: normalizeBillingError(error),
			});
		}
	}

	async function handleWalletRetry() {
		if (!state?.subscriptionId) return;
		try {
			await retryWallet.mutateAsync({ subscription_id: state.subscriptionId });
			toast.success("Wallet payment recovered", {
				description: "Paid compute is active again.",
			});
		} catch (error) {
			if (error instanceof BillingApiError && error.status === 402) setTopUpOpen(true);
			toast.error("Couldn’t retry wallet payment", {
				description:
					error instanceof BillingApiError && error.status === 409
						? "Another billing action is in progress, or this payment no longer needs recovery. Refresh and try again."
						: normalizeBillingError(error),
			});
		}
	}

	return (
		<>
			<Alert
				data-hosted="true"
				variant={destructive ? "destructive" : "default"}
				className={destructive ? undefined : "border-warning/30 bg-warning-muted"}
			>
				<TriangleAlert />
				<AlertTitle>{state.title}</AlertTitle>
				<AlertDescription className="flex flex-col items-start gap-3">
					<span>{bannerDescription}</span>
					{state.ctaTarget === "wallet" ? (
						<div className="flex flex-col items-start gap-2">
							<div className="flex flex-wrap gap-2">
								<Button
									size="sm"
									variant={destructive ? "destructive" : "default"}
									onClick={() => setTopUpOpen(true)}
									disabled={!wallet.data}
								>
									<WalletCards data-icon="inline-start" /> Top up
								</Button>
								<Button
									size="sm"
									variant="outline"
									onClick={() => void handleWalletRetry()}
									disabled={retryWallet.isPending || !state.subscriptionId}
								>
									{retryWallet.isPending ? <Spinner /> : <RefreshCw data-icon="inline-start" />}
									Retry payment
								</Button>
							</div>
							{state.subscriptionId ? null : (
								<span className="text-xs text-muted-foreground">
									Retry becomes available after wallet billing details finish syncing.
								</span>
							)}
						</div>
					) : (
						<Button
							size="sm"
							variant={destructive ? "destructive" : "default"}
							onClick={() => void handleFixPayment()}
							disabled={fixPayment.isPending && state.ctaTarget === "portal"}
						>
							{fixPayment.isPending && state.ctaTarget === "portal" ? (
								<Spinner />
							) : state.ctaTarget === "invoice" ? (
								<ExternalLink data-icon="inline-start" />
							) : (
								<CreditCard data-icon="inline-start" />
							)}
							Fix payment
						</Button>
					)}
				</AlertDescription>
			</Alert>
			{wallet.data ? (
				<TopUpDialog open={topUpOpen} onOpenChange={setTopUpOpen} wallet={wallet.data} />
			) : null}
		</>
	);
}
