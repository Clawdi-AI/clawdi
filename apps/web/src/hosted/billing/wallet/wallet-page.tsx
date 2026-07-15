"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { PageHeader } from "@/components/page-header";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import { LowBalanceBanner } from "@/hosted/billing/components/low-balance-banner";
import { WalletSkeleton } from "@/hosted/billing/components/state-views";
import { billingErrorNormalizer } from "@/hosted/billing/errors";
import { useHostedDeployments, usePlans, useWallet, useWalletLedger } from "@/hosted/billing/hooks";
import { getStripe } from "@/hosted/billing/stripe";
import { AutoReloadCard } from "@/hosted/billing/wallet/auto-reload-card";
import { BalanceCard } from "@/hosted/billing/wallet/balance-card";
import { ComputeCommitmentCard } from "@/hosted/billing/wallet/compute-commitment-card";
import { LedgerTable } from "@/hosted/billing/wallet/ledger-table";
import { TopUpDialog } from "@/hosted/billing/wallet/top-up-dialog";
import { invalidateWalletActivity } from "@/hosted/billing/wallet/top-up-dialog.logic";
import {
	cleanWalletTopupReturnUrl,
	readWalletTopupReturn,
	type WalletTopupReturnToast,
	walletTopupReturnToast,
} from "@/hosted/billing/wallet/top-up-return.logic";
import { LEDGER_MAX_ROWS, LEDGER_PAGE_SIZE } from "@/hosted/billing/wallet/wallet-constants";
import { X402Card } from "@/hosted/billing/wallet/x402-card";
import { shouldShowX402Card } from "@/hosted/billing/wallet/x402-card.logic";
import { env } from "@/lib/env";
import { cn } from "@/lib/utils";

const DESCRIPTION = "One balance for managed AI, wallet-funded compute, top-ups, and auto-reload.";
const WALLET_PAGE_CLASS = cn(CENTERED_PAGE_WIDTH_CLASS.page, "space-y-6 px-4 lg:px-6");

function scrollToAutoReload() {
	document.getElementById("auto-reload")?.scrollIntoView({ behavior: "smooth", block: "center" });
}

function showWalletTopupReturnToast(result: WalletTopupReturnToast) {
	if (result.kind === "success") {
		toast.success(result.title, { description: result.description });
		return;
	}
	if (result.kind === "error") {
		toast.error(result.title, { description: result.description });
		return;
	}
	toast.info(result.title, { description: result.description });
}

export function WalletPage() {
	const wallet = useWallet();
	const deployments = useHostedDeployments();
	const plans = usePlans();
	const queryClient = useQueryClient();
	const [ledgerLimit, setLedgerLimit] = useState(LEDGER_PAGE_SIZE);
	const ledger = useWalletLedger(ledgerLimit);
	const [topUpOpen, setTopUpOpen] = useState(false);

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
				showWalletTopupReturnToast(walletTopupReturnToast(result.paymentIntent?.status));
				invalidateWalletActivity(queryClient);
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

	if (wallet.error || !wallet.data) {
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
			(deployment) => deployment.compute_subscription?.funding_source === "wallet",
		).length ?? 0;

	return (
		<div data-hosted="true" className={WALLET_PAGE_CLASS}>
			{/* The balance card below carries the primary Top up CTA; a second
			    header button duplicated it in the same viewport. */}
			<PageHeader title="Wallet" description={DESCRIPTION} />

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
			/>

			<ComputeCommitmentCard
				wallet={w}
				deployments={deployments.data}
				plans={plans.data}
				isLoading={deployments.isLoading}
				error={deployments.error}
				onRetry={() => void deployments.refetch()}
			/>

			<div id="auto-reload" className="grid gap-4 lg:grid-cols-2">
				<AutoReloadCard wallet={w} onTopUp={() => setTopUpOpen(true)} />
				{shouldShowX402Card(w) ? <X402Card /> : null}
			</div>

			{ledger.error && !ledger.data ? (
				<ApiErrorPanel
					normalizer={billingErrorNormalizer}
					error={ledger.error}
					title="Couldn’t load activity"
					onRetry={() => ledger.refetch()}
				/>
			) : (
				<LedgerTable
					entries={ledger.data?.items ?? []}
					pointsPerUsd={w.points_per_usd}
					isLoading={ledger.isLoading}
					hasMore={(ledger.data?.items.length ?? 0) >= ledgerLimit && ledgerLimit < LEDGER_MAX_ROWS}
					atCap={(ledger.data?.items.length ?? 0) >= LEDGER_MAX_ROWS}
					isFetchingMore={ledger.isFetching}
					onShowMore={() => setLedgerLimit((n) => Math.min(n + LEDGER_PAGE_SIZE, LEDGER_MAX_ROWS))}
				/>
			)}

			<TopUpDialog open={topUpOpen} onOpenChange={setTopUpOpen} wallet={w} />
		</div>
	);
}
