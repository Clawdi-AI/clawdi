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
import { walletActivationFailure } from "@/hosted/billing/deploy/deploy-wallet.logic";
import {
	BillingApiError,
	normalizeBillingError,
	walletComputeErrorDetail,
	walletRefundDebtCredits,
} from "@/hosted/billing/errors";
import {
	useActivateWalletCompute,
	useFixPayment,
	useRetryWalletCompute,
	useWallet,
	useWalletComputeQuote,
} from "@/hosted/billing/hooks";
import { computeTierLabel } from "@/hosted/billing/subscription/subscription-utils";
import { TopUpDialog } from "@/hosted/billing/wallet/top-up-dialog";
import { topUpAmountCentsForCreditShortfall } from "@/hosted/billing/wallet/top-up-dialog.logic";
import { decimalCredits } from "@/hosted/billing/wallet/wallet-compute.logic";
import { formatShortDate } from "@/lib/format";
import { settingsQueryHref } from "@/lib/settings-routes";
import {
	collectionFailureMessage,
	computeDunningState,
	dunningDeadlineCountdown,
	fallbackReasonSentence,
	fixPaymentRequestForDunning,
} from "./compute-dunning.logic";

export function ComputeDunningBanner({ deployment }: { deployment: HostedDeployment }) {
	const state = computeDunningState(deployment);
	const fixPayment = useFixPayment();
	const retryWallet = useRetryWalletCompute();
	const activateWallet = useActivateWalletCompute();
	const walletRecovery =
		state?.ctaTarget === "wallet_retry" || state?.ctaTarget === "wallet_reactivate";
	const wallet = useWallet({ enabled: walletRecovery });
	const reactivationQuote = useWalletComputeQuote(
		state?.ctaTarget === "wallet_reactivate" && state.recoveryPlanSlug
			? { plan_slug: state.recoveryPlanSlug, billing_term_months: 1 }
			: null,
	);
	const [topUpOpen, setTopUpOpen] = useState(false);
	const [topUpCredits, setTopUpCredits] = useState<number | null>(null);
	const [refundDebtCredits, setRefundDebtCredits] = useState<number | null>(null);
	const [now, setNow] = useState(() => Date.now());

	useEffect(() => {
		if (!state?.serviceRiskAt || state.ctaTarget !== "wallet_retry") return;
		const interval = window.setInterval(() => setNow(Date.now()), 60_000);
		return () => window.clearInterval(interval);
	}, [state?.ctaTarget, state?.serviceRiskAt]);

	if (!state) return null;

	const countdown =
		state.ctaTarget === "wallet_retry" ? dunningDeadlineCountdown(state.serviceRiskAt, now) : null;
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
			const res = await fixPayment.mutateAsync(fixPaymentRequestForDunning(state, deployment.id));
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
				setTopUpCredits(Number.isFinite(shortfall) ? shortfall : null);
				setRefundDebtCredits(null);
				setTopUpOpen(true);
			} else if (error instanceof BillingApiError && error.status === 409) {
				const debtCredits = walletRefundDebtCredits(error);
				if (debtCredits !== null) {
					setRefundDebtCredits(debtCredits);
					setTopUpCredits(debtCredits + blockedChargeCredits);
					setTopUpOpen(true);
				}
			}
			toast.error("Couldn’t retry wallet payment", {
				description:
					error instanceof BillingApiError && error.status === 409
						? "Another billing action is in progress, or this payment no longer needs recovery. Refresh and try again."
						: normalizeBillingError(error),
			});
		}
	}

	async function handleWalletReactivate() {
		if (!state?.recoveryPlanSlug) return;
		try {
			await activateWallet.mutateAsync({
				plan_slug: state.recoveryPlanSlug,
				billing_term_months: 1,
				upgrade_deployment_id: deployment.id,
			});
			toast.success(`${computeTierLabel(state.recoveryPlanSlug)} compute reactivated`, {
				description: "A new wallet-funded subscription is active.",
			});
		} catch (error) {
			const failure = walletActivationFailure(error, blockedChargeCredits);
			if (failure.kind === "insufficient" || failure.kind === "refund_debt") {
				setTopUpCredits(failure.topUpCredits);
				setRefundDebtCredits(failure.debtCredits);
				setTopUpOpen(true);
			}
			toast.error("Couldn’t reactivate wallet compute", {
				description: failure.description,
			});
		}
	}

	function openManualTopUp() {
		setTopUpCredits(null);
		setRefundDebtCredits(null);
		setTopUpOpen(true);
	}

	const blockedChargeCredits =
		state.ctaTarget === "wallet_reactivate"
			? decimalCredits(reactivationQuote.data?.first_charge_credits)
			: state.ctaTarget === "wallet_retry" && wallet.data
				? ((deployment.compute_subscription?.price_cents ?? 0) / 100) * wallet.data.points_per_usd
				: 0;

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
					{state.ctaTarget === "wallet_retry" ? (
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
					) : state.ctaTarget === "wallet_reactivate" ? (
						<div className="flex flex-wrap gap-2">
							<Button
								size="sm"
								variant={destructive ? "destructive" : "default"}
								onClick={() => void handleWalletReactivate()}
								disabled={activateWallet.isPending || !state.recoveryPlanSlug}
							>
								{activateWallet.isPending ? <Spinner /> : <RefreshCw data-icon="inline-start" />}
								Reactivate{" "}
								{state.recoveryPlanSlug ? computeTierLabel(state.recoveryPlanSlug) : "compute"}
							</Button>
							<Button size="sm" variant="outline" onClick={openManualTopUp} disabled={!wallet.data}>
								<WalletCards data-icon="inline-start" /> Top up first
							</Button>
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
						topUpCredits,
						wallet.data.points_per_usd,
					)}
					refundDebtCredits={refundDebtCredits}
					blockedChargeCredits={blockedChargeCredits}
				/>
			) : null}
		</>
	);
}
