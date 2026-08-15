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
import {
	useSensitiveBillingPortal,
	useSensitiveFinalizeWalletAutoReloadSetup,
} from "@/hosted/billing/sensitive-actions";
import { getStripe } from "@/hosted/billing/stripe";
import { useActionLock } from "@/hosted/billing/use-action-lock";
import { AutoReloadCard } from "@/hosted/billing/wallet/auto-reload-card";
import { BalanceCard } from "@/hosted/billing/wallet/balance-card";
import {
	coordinateWalletPaymentReturn,
	coordinateWalletSetupReturn,
	type WalletSetupReturnFinalizer,
} from "@/hosted/billing/wallet/stripe-return";
import { confirmWalletTopup, TopUpDialog } from "@/hosted/billing/wallet/top-up-dialog";
import { invalidateWalletData } from "@/hosted/billing/wallet/top-up-dialog.logic";
import {
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
	const finalizeSetup = useSensitiveFinalizeWalletAutoReloadSetup();
	const runAction = useActionLock();
	const queryClient = useQueryClient();
	const [topUpOpen, setTopUpOpen] = useState(false);

	const finalizeReturnedSetup: WalletSetupReturnFinalizer = async (confirmed) => {
		try {
			await finalizeSetup.execute({
				setup_identity: confirmed.setupIdentity,
				setup_intent_id: confirmed.setupIntentId,
			});
			invalidateWalletData(queryClient);
			return null;
		} catch (error) {
			return normalizeBillingError(error);
		}
	};

	function showReturnedSetupFinalizeError(
		confirmed: Parameters<WalletSetupReturnFinalizer>[0],
		errorMessage: string,
	) {
		toast.warning("Card authorized; Wallet hasn’t saved it yet", {
			description: errorMessage,
			action: {
				label: "Retry saving",
				onClick: () => {
					void finalizeReturnedSetup(confirmed).then((retryError) => {
						if (retryError) {
							showReturnedSetupFinalizeError(confirmed, retryError);
							return;
						}
						toast.success("Auto-reload card authorized", {
							description: "Your Wallet card authorization is saved.",
						});
					});
				},
			},
		});
	}

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
		const resolution = coordinateWalletPaymentReturn(async (pending) => {
			try {
				const key = env.VITE_STRIPE_PUBLISHABLE_KEY;
				if (!key) {
					return {
						status: null,
						paymentIntentId: null,
						errorMessage: "Payments are temporarily unavailable. Please try again later.",
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
				const result = await stripe.retrievePaymentIntent(pending.clientSecret);
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
		void resolution.then(({ flow, status, paymentIntentId, errorMessage }) => {
			if (cancelled) return;
			if (errorMessage) {
				toast.error(
					flow === "manual_topup"
						? "Couldn't refresh top-up"
						: "Couldn't refresh auto-reload payment",
					{ description: errorMessage },
				);
				return;
			}
			invalidateWalletData(queryClient);
			if (flow === "auto_reload") {
				if (status === "succeeded") {
					toast.success("Auto-reload payment confirmed", {
						description: "Wallet is refreshing your balance and auto-reload status.",
					});
				} else if (status === "processing" || status === "requires_capture") {
					toast.info("Auto-reload payment processing", {
						description: "Wallet will update after the payment settles.",
					});
				} else {
					toast.error("Auto-reload payment didn't finish", {
						description: "Review the pending payment in Wallet and try again.",
					});
				}
				return;
			}
			showWalletTopupReturnToast(walletTopupReturnToast(status));
			if (status === "succeeded" || status === "processing" || status === "requires_capture") {
				void confirmWalletTopup(queryClient, paymentIntentId);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [queryClient]);

	useEffect(() => {
		let cancelled = false;
		const resolution = coordinateWalletSetupReturn(async (pending) => {
			try {
				const key = env.VITE_STRIPE_PUBLISHABLE_KEY;
				if (!key) {
					return {
						status: null,
						setupIntentId: null,
						setupIdentity: pending.setupIdentity,
						errorMessage: "Card authorization is temporarily unavailable. Please try again later.",
					};
				}
				const stripe = await getStripe(key);
				if (!stripe) {
					return {
						status: null,
						setupIntentId: null,
						setupIdentity: pending.setupIdentity,
						errorMessage: "Reload the page and try the card authorization again.",
					};
				}
				const result = await stripe.retrieveSetupIntent(pending.clientSecret);
				if (result.error) {
					return {
						status: null,
						setupIntentId: null,
						setupIdentity: pending.setupIdentity,
						errorMessage: result.error.message ?? "Open Wallet and start a new card authorization.",
					};
				}
				return {
					status: result.setupIntent?.status ?? null,
					setupIntentId: result.setupIntent?.id ?? null,
					setupIdentity: pending.setupIdentity,
					errorMessage: null,
				};
			} catch {
				return {
					status: null,
					setupIntentId: null,
					setupIdentity: pending.setupIdentity,
					errorMessage: "Check your connection and reload Wallet.",
				};
			}
		}, finalizeReturnedSetup);
		if (!resolution) return;
		void resolution.then(({ status, setupIdentity, setupIntentId, errorMessage }) => {
			if (cancelled) return;
			if (errorMessage) {
				if (status === "succeeded" && setupIntentId) {
					showReturnedSetupFinalizeError({ setupIdentity, setupIntentId }, errorMessage);
				} else {
					toast.error("Couldn’t finish card authorization", { description: errorMessage });
				}
				return;
			}
			if (status === "succeeded") {
				toast.success("Auto-reload card authorized", {
					description: "Your Wallet card authorization is saved.",
				});
				return;
			}
			toast.error("Card authorization didn’t finish", {
				description: "Review auto-reload settings and start a new card authorization.",
			});
		});
		return () => {
			cancelled = true;
		};
	}, [finalizeSetup.execute, queryClient]);

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
