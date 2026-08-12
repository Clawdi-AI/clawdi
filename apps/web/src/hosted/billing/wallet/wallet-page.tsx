"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { SettingsPanelHeader } from "@/components/settings/settings-panel-header";
import { LowBalanceBanner } from "@/hosted/billing/components/low-balance-banner";
import { WalletSkeleton } from "@/hosted/billing/components/state-views";
import { billingErrorNormalizer, normalizeBillingError } from "@/hosted/billing/errors";
import { useHostedDeployments } from "@/hosted/billing/hooks";
import { useSensitiveBillingPortal } from "@/hosted/billing/sensitive-actions";
import { getStripe } from "@/hosted/billing/stripe";
import { useActionLock } from "@/hosted/billing/use-action-lock";
import { AutoReloadCard } from "@/hosted/billing/wallet/auto-reload-card";
import { BalanceCard } from "@/hosted/billing/wallet/balance-card";
import { confirmWalletTopup, TopUpDialog } from "@/hosted/billing/wallet/top-up-dialog";
import { invalidateWalletData } from "@/hosted/billing/wallet/top-up-dialog.logic";
import {
	coordinateWalletTopupReturn,
	type WalletTopupReturnToast,
	walletTopupReturnToast,
} from "@/hosted/billing/wallet/top-up-return.logic";
import { TransactionsSection } from "@/hosted/billing/wallet/transactions-section";
import { useWalletSnapshot } from "@/hosted/billing/wallet/wallet-query";
import { X402Card } from "@/hosted/billing/wallet/x402-card";
import { env } from "@/lib/env";
import { shouldBlockQueryError } from "@/lib/query-state";

const DESCRIPTION = "Add funds and manage how your Clawdi usage is paid.";
const WALLET_PAGE_CLASS = "flex flex-col gap-8 px-5 sm:px-6 lg:px-8";

function scrollToAutoReload() {
	const section = document.getElementById("auto-reload");
	if (!section) return;
	const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
	section.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
	window.requestAnimationFrame(() =>
		section.querySelector<HTMLButtonElement>("[data-auto-reload-primary]")?.focus(),
	);
}

function showWalletTopupReturnToast(result: WalletTopupReturnToast) {
	if (result.kind === "error") {
		toast.error(result.title, { description: result.description });
		return;
	}
	toast.info(result.title, { description: result.description });
}

export function WalletPage() {
	const wallet = useWalletSnapshot();
	const deployments = useHostedDeployments();
	const portal = useSensitiveBillingPortal();
	const runAction = useActionLock();
	const queryClient = useQueryClient();
	const [topUpOpen, setTopUpOpen] = useState(false);

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
		} catch (error) {
			toast.error("Couldn’t open billing", { description: normalizeBillingError(error) });
		}
	}

	useEffect(() => {
		let cancelled = false;
		const resolution = coordinateWalletTopupReturn(async (clientSecret) => {
			try {
				const key = env.VITE_STRIPE_PUBLISHABLE_KEY;
				if (!key) {
					return {
						status: null,
						paymentIntentId: null,
						errorMessage: "Stripe isn't configured in this environment.",
					};
				}
				const stripe = await getStripe(key);
				if (!stripe) {
					return {
						status: null,
						paymentIntentId: null,
						errorMessage: "Reload the page and try again.",
					};
				}
				const result = await stripe.retrievePaymentIntent(clientSecret);
				if (result.error) {
					return {
						status: null,
						paymentIntentId: null,
						errorMessage: result.error.message ?? "Open Wallet and try again.",
					};
				}
				const paymentIntent = result.paymentIntent;
				return {
					status: paymentIntent?.status ?? null,
					paymentIntentId: paymentIntent?.id ?? null,
					errorMessage: null,
				};
			} catch {
				return {
					status: null,
					paymentIntentId: null,
					errorMessage: "Check your connection and reload Wallet.",
				};
			}
		});
		if (!resolution) return;
		void resolution.then(({ status, paymentIntentId, errorMessage }) => {
			if (cancelled) return;
			if (errorMessage) {
				toast.error("Couldn't refresh top-up", { description: errorMessage });
				return;
			}
			showWalletTopupReturnToast(walletTopupReturnToast(status));
			invalidateWalletData(queryClient);
			if (status === "succeeded" || status === "processing" || status === "requires_capture") {
				void confirmWalletTopup(queryClient, paymentIntentId);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [queryClient]);

	if (wallet.isLoading) {
		return (
			<div data-hosted="true" className={WALLET_PAGE_CLASS}>
				<SettingsPanelHeader title="Wallet" description={DESCRIPTION} />
				<WalletSkeleton />
			</div>
		);
	}

	if (shouldBlockQueryError(wallet.error, wallet.data) || !wallet.data) {
		return (
			<div data-hosted="true" className={WALLET_PAGE_CLASS}>
				<SettingsPanelHeader title="Wallet" description={DESCRIPTION} />
				<ApiErrorPanel
					normalizer={billingErrorNormalizer}
					error={wallet.error}
					onRetry={() => wallet.refetch()}
				/>
			</div>
		);
	}

	const w = wallet.data;
	const walletComputeCount =
		deployments.data?.filter(
			(deployment) =>
				deployment.commercial_display?.compute_subscription?.funding_source === "wallet",
		).length ?? 0;

	return (
		<div data-hosted="true" className={WALLET_PAGE_CLASS}>
			<SettingsPanelHeader title="Wallet" description={DESCRIPTION} />

			<TopUpDialog
				open={topUpOpen}
				onOpenChange={setTopUpOpen}
				onComplete={(_status, paymentReference) => {
					void confirmWalletTopup(queryClient, paymentReference);
				}}
			/>

			<div className="space-y-8">
				<LowBalanceBanner
					wallet={w}
					hasWalletCompute={walletComputeCount > 0}
					onTopUp={() => setTopUpOpen(true)}
					onAutoReload={scrollToAutoReload}
				/>

				<BalanceCard
					wallet={w}
					hasWalletCompute={walletComputeCount > 0}
					onTopUp={() => setTopUpOpen(true)}
					onManagePaymentMethods={() => void runAction(openBillingPortal)}
					isManagePaymentMethodsPending={portal.isPending}
				/>

				<div id="auto-reload" data-testid="auto-reload-section">
					<AutoReloadCard wallet={w} onTopUp={() => setTopUpOpen(true)} />
				</div>

				<X402Card />

				<TransactionsSection />
			</div>
		</div>
	);
}
