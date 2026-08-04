"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { PageHeader } from "@/components/page-header";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import { LowBalanceBanner } from "@/hosted/billing/components/low-balance-banner";
import { WalletSkeleton } from "@/hosted/billing/components/state-views";
import { billingErrorNormalizer, normalizeBillingError } from "@/hosted/billing/errors";
import { useHostedDeployments, useWalletLedgerPages } from "@/hosted/billing/hooks";
import { useSensitiveBillingPortal } from "@/hosted/billing/sensitive-actions";
import { getStripe } from "@/hosted/billing/stripe";
import { useActionLock } from "@/hosted/billing/use-action-lock";
import { AutoReloadCard } from "@/hosted/billing/wallet/auto-reload-card";
import { BalanceCard } from "@/hosted/billing/wallet/balance-card";
import { LedgerTable } from "@/hosted/billing/wallet/ledger-table";
import { confirmWalletTopup, TopUpDialog } from "@/hosted/billing/wallet/top-up-dialog";
import { invalidateWalletActivity } from "@/hosted/billing/wallet/top-up-dialog.logic";
import {
	cleanWalletTopupReturnUrl,
	readWalletTopupReturn,
	type WalletTopupReturnToast,
	walletTopupReturnToast,
} from "@/hosted/billing/wallet/top-up-return.logic";
import { LEDGER_PAGE_SIZE } from "@/hosted/billing/wallet/wallet-constants";
import { useWalletSnapshot } from "@/hosted/billing/wallet/wallet-query";
import { X402Card } from "@/hosted/billing/wallet/x402-card";
import { env } from "@/lib/env";
import { shouldBlockQueryError } from "@/lib/query-state";
import { cn } from "@/lib/utils";

const DESCRIPTION = "Add funds and manage how your Clawdi usage is paid.";
const WALLET_PAGE_CLASS = cn(CENTERED_PAGE_WIDTH_CLASS.page, "space-y-6 px-4 lg:px-6");

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
	const ledger = useWalletLedgerPages(LEDGER_PAGE_SIZE);
	const ledgerEntries = ledger.data?.pages.flatMap((page) => page.items) ?? [];
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
		const topupReturn = readWalletTopupReturn(window.location.search);
		if (!topupReturn) return;
		const { clientSecret } = topupReturn;
		let cancelled = false;

		async function refreshReturnedTopup() {
			try {
				const key = env.VITE_STRIPE_PUBLISHABLE_KEY;
				if (!key) {
					toast.error("Couldn't refresh top-up", {
						description: "Stripe isn't configured in this environment.",
					});
					return;
				}
				const stripe = await getStripe(key);
				if (!stripe) {
					toast.error("Couldn't refresh top-up", {
						description: "Reload the page and try again.",
					});
					return;
				}
				const result = await stripe.retrievePaymentIntent(clientSecret);
				if (cancelled) return;
				if (result.error) {
					toast.error("Couldn't refresh top-up", {
						description: result.error.message ?? "Open Wallet and try again.",
					});
					return;
				}
				const paymentIntent = result.paymentIntent;
				const status = paymentIntent?.status;
				showWalletTopupReturnToast(walletTopupReturnToast(status));
				invalidateWalletActivity(queryClient);
				if (status === "succeeded" || status === "processing" || status === "requires_capture") {
					void confirmWalletTopup(queryClient, paymentIntent?.id ?? null);
				}
			} catch {
				if (!cancelled) {
					toast.error("Couldn't refresh top-up", {
						description: "Check your connection and reload Wallet.",
					});
				}
			} finally {
				if (!cancelled) {
					window.history.replaceState(null, "", cleanWalletTopupReturnUrl(window.location.href));
				}
			}
		}

		void refreshReturnedTopup();
		return () => {
			cancelled = true;
		};
	}, [queryClient]);

	if (wallet.isLoading) {
		return (
			<div data-hosted="true" className={WALLET_PAGE_CLASS}>
				<PageHeader title="Wallet" description={DESCRIPTION} />
				<WalletSkeleton />
			</div>
		);
	}

	if (shouldBlockQueryError(wallet.error, wallet.data) || !wallet.data) {
		return (
			<div data-hosted="true" className={WALLET_PAGE_CLASS}>
				<PageHeader title="Wallet" description={DESCRIPTION} />
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
			<PageHeader title="Wallet" description={DESCRIPTION} />

			<TopUpDialog open={topUpOpen} onOpenChange={setTopUpOpen} presentation="inline" />

			<div className={cn("space-y-6", topUpOpen && "hidden")}>
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

				<div id="auto-reload">
					<AutoReloadCard
						wallet={w}
						onTopUp={() => setTopUpOpen(true)}
						onManagePaymentMethods={() => void runAction(openBillingPortal)}
						isManagePaymentMethodsPending={portal.isPending}
					/>
				</div>

				<X402Card enabled={w.x402_enabled === true} />

				{ledger.error && !ledger.data ? (
					<ApiErrorPanel
						normalizer={billingErrorNormalizer}
						error={ledger.error}
						title="Couldn’t load activity"
						onRetry={() => ledger.refetch()}
					/>
				) : (
					<>
						<LedgerTable
							entries={ledgerEntries}
							isLoading={ledger.isLoading}
							hasMore={ledger.hasNextPage}
							isFetchingMore={ledger.isFetchingNextPage}
							onShowMore={() => void ledger.fetchNextPage()}
						/>
						{ledger.isFetchNextPageError ? (
							<ApiErrorPanel
								normalizer={billingErrorNormalizer}
								error={ledger.error}
								title="Couldn’t load more activity"
								onRetry={() => void ledger.fetchNextPage()}
							/>
						) : null}
					</>
				)}
			</div>
		</div>
	);
}
