"use client";

import {
	CreditCard,
	ExternalLink,
	History,
	Info,
	LifeBuoy,
	RefreshCw,
	TriangleAlert,
	WalletCards,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { HostedDeployment } from "@/hosted/billing/contracts";
import {
	BillingApiError,
	normalizeBillingError,
	walletComputeErrorDetail,
} from "@/hosted/billing/errors";
import { useFixPayment, useRetryWalletCompute, useWallet } from "@/hosted/billing/hooks";
import { TopUpDialog } from "@/hosted/billing/wallet/top-up-dialog";
import { topUpAmountCentsForCreditShortfall } from "@/hosted/billing/wallet/top-up-dialog.logic";
import { formatShortDate } from "@/lib/format";
import { settingsQueryHref } from "@/lib/settings-routes";
import {
	collectionFailureMessage,
	computeDunningState,
	dunningDeadlineCountdown,
	fallbackReasonSentence,
} from "./compute-dunning.logic";

export function ComputeDunningBanner({ deployment }: { deployment: HostedDeployment }) {
	const state = computeDunningState(deployment);
	const fixPayment = useFixPayment();
	const retryWallet = useRetryWalletCompute();
	const wallet = useWallet({ enabled: state?.ctaTarget === "wallet" });
	const [topUpOpen, setTopUpOpen] = useState(false);
	const [retryShortfallCredits, setRetryShortfallCredits] = useState<number | null>(null);
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
			if (error instanceof BillingApiError && error.status === 402) {
				const detail = walletComputeErrorDetail(error);
				const shortfall =
					detail && typeof detail !== "string" && "shortfall_credits" in detail
						? Number(detail.shortfall_credits)
						: Number.NaN;
				setRetryShortfallCredits(Number.isFinite(shortfall) ? shortfall : null);
				setTopUpOpen(true);
			}
			toast.error("Couldn’t retry wallet payment", {
				description:
					error instanceof BillingApiError && error.status === 409
						? "Another billing action is in progress, or this payment no longer needs recovery. Refresh and try again."
						: normalizeBillingError(error),
			});
		}
	}

	function openManualTopUp() {
		setRetryShortfallCredits(null);
		setTopUpOpen(true);
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
				<BannerIcon />
				<AlertTitle>{state.title}</AlertTitle>
				<AlertDescription className="flex flex-col items-start gap-3">
					<span>{bannerDescription}</span>
					{state.ctaTarget === "wallet" ? (
						<div className="flex flex-col items-start gap-2">
							<div className="flex flex-wrap gap-2">
								<Button
									size="sm"
									variant={destructive ? "destructive" : "default"}
									onClick={openManualTopUp}
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
					) : state.ctaTarget !== "none" ? (
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
					) : null}
				</AlertDescription>
			</Alert>
			{wallet.data ? (
				<TopUpDialog
					open={topUpOpen}
					onOpenChange={setTopUpOpen}
					wallet={wallet.data}
					initialAmountCents={topUpAmountCentsForCreditShortfall(
						retryShortfallCredits,
						wallet.data.points_per_usd,
					)}
				/>
			) : null}
		</>
	);
}
