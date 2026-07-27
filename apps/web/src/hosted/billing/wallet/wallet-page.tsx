"use client";

import { useQueryClient } from "@tanstack/react-query";
import { CircleDollarSign, CreditCard, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { PageHeader } from "@/components/page-header";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { LowBalanceBanner } from "@/hosted/billing/components/low-balance-banner";
import { WalletSkeleton } from "@/hosted/billing/components/state-views";
import { billingErrorNormalizer, normalizeBillingError } from "@/hosted/billing/errors";
import { formatCents } from "@/hosted/billing/format";
import { useHostedDeployments, useWalletLedger } from "@/hosted/billing/hooks";
import { useSensitiveBillingPortal } from "@/hosted/billing/sensitive-actions";
import { getStripe } from "@/hosted/billing/stripe";
import { useActionLock } from "@/hosted/billing/use-action-lock";
import { AutoReloadCard } from "@/hosted/billing/wallet/auto-reload-card";
import { BalanceCard } from "@/hosted/billing/wallet/balance-card";
import { LedgerTable } from "@/hosted/billing/wallet/ledger-table";
import {
	clearPendingTopUpCredit,
	type PendingTopUpCredit,
	pendingTopUpCreditIsApplied,
	readPendingTopUpCredit,
	TOP_UP_CREDIT_RECHECK_INTERVAL_MS,
	TOP_UP_CREDIT_TIMEOUT_MS,
	writePendingTopUpCredit,
} from "@/hosted/billing/wallet/pending-top-up";
import { TopUpDialog } from "@/hosted/billing/wallet/top-up-dialog";
import { invalidateWalletActivity } from "@/hosted/billing/wallet/top-up-dialog.logic";
import {
	cleanWalletTopupReturnUrl,
	readWalletTopupReturn,
	type WalletTopupReturnToast,
	walletTopupReturnToast,
} from "@/hosted/billing/wallet/top-up-return.logic";
import { LEDGER_MAX_ROWS, LEDGER_PAGE_SIZE } from "@/hosted/billing/wallet/wallet-constants";
import { useWalletSnapshot } from "@/hosted/billing/wallet/wallet-query";
import { X402Card } from "@/hosted/billing/wallet/x402-card";
import { env } from "@/lib/env";
import { cn } from "@/lib/utils";

const DESCRIPTION = "One balance for managed AI, wallet-funded compute, top-ups, and auto-reload.";
const WALLET_PAGE_CLASS = cn(CENTERED_PAGE_WIDTH_CLASS.page, "space-y-6 px-4 lg:px-6");

function scrollToAutoReload() {
	const section = document.getElementById("auto-reload");
	if (!section) return;
	const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
	section.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
	window.requestAnimationFrame(() => document.getElementById("auto-reload-enabled")?.focus());
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
	const wallet = useWalletSnapshot();
	const deployments = useHostedDeployments();
	const portal = useSensitiveBillingPortal();
	const runAction = useActionLock();
	const queryClient = useQueryClient();
	const [ledgerLimit, setLedgerLimit] = useState(LEDGER_PAGE_SIZE);
	const ledger = useWalletLedger(ledgerLimit);
	const lastLedgerDataRef = useRef(ledger.data);
	if (ledger.data) lastLedgerDataRef.current = ledger.data;
	const ledgerData = ledger.data ?? lastLedgerDataRef.current;
	const [topUpOpen, setTopUpOpen] = useState(false);
	const [pendingTopUp, setPendingTopUp] = useState<PendingTopUpCredit | null>(null);
	const [topUpCheckTimedOut, setTopUpCheckTimedOut] = useState(false);
	const topUpRefetchInFlight = useRef(false);
	const refetchWallet = wallet.refetch;
	const refetchLedger = ledger.refetch;
	const pendingTopUpApplied = pendingTopUp
		? pendingTopUpCreditIsApplied(pendingTopUp, ledgerData?.items ?? [])
		: false;

	const rememberPendingTopUp = useCallback((pending: PendingTopUpCredit) => {
		setPendingTopUp(pending);
		setTopUpCheckTimedOut(false);
		writePendingTopUpCredit(window.sessionStorage, pending);
	}, []);

	useEffect(() => {
		const stored = readPendingTopUpCredit(window.sessionStorage);
		if (!stored) return;
		setPendingTopUp(stored);
		setTopUpCheckTimedOut(Date.now() >= stored.checkStartedAtMs + TOP_UP_CREDIT_TIMEOUT_MS);
	}, []);

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

	const portalAction = (
		<Button
			variant="outline"
			onClick={() => runAction(openBillingPortal)}
			disabled={portal.isPending}
		>
			{portal.isPending ? <Spinner /> : <CreditCard />} Manage payment methods
		</Button>
	);

	useEffect(() => {
		const topupReturn = readWalletTopupReturn(window.location.search);
		if (!topupReturn) return;
		const { clientSecret } = topupReturn;
		let cancelled = false;

		async function refreshReturnedTopup() {
			function rememberUnknownReturn() {
				const now = Date.now();
				rememberPendingTopUp({
					providerStatus: "unknown",
					amountCents: null,
					paymentStartedAtMs: now,
					checkStartedAtMs: now,
				});
			}

			try {
				const key = env.VITE_STRIPE_PUBLISHABLE_KEY;
				if (!key) {
					rememberUnknownReturn();
					toast.error("Couldn't refresh top-up", {
						description: "Stripe isn't configured in this environment.",
					});
					return;
				}
				const stripe = await getStripe(key);
				if (!stripe) {
					rememberUnknownReturn();
					toast.error("Couldn't refresh top-up", {
						description: "Check Wallet again in a moment.",
					});
					return;
				}
				const result = await stripe.retrievePaymentIntent(clientSecret);
				if (cancelled) return;
				if (result.error) {
					rememberUnknownReturn();
					toast.error("Couldn't refresh top-up", {
						description: result.error.message ?? "Check Wallet again in a moment.",
					});
					return;
				}
				const paymentIntent = result.paymentIntent;
				const status = paymentIntent?.status;
				showWalletTopupReturnToast(walletTopupReturnToast(status));
				if (status === "succeeded" || status === "processing" || status === "requires_capture") {
					const now = Date.now();
					const amountCents = paymentIntent?.amount ?? null;
					rememberPendingTopUp({
						providerStatus: status === "succeeded" ? "succeeded" : "processing",
						amountCents,
						paymentStartedAtMs: paymentIntent ? paymentIntent.created * 1_000 : now,
						checkStartedAtMs: now,
					});
				} else if (status === "requires_payment_method" || status === "canceled") {
					clearPendingTopUpCredit(window.sessionStorage);
					setPendingTopUp(null);
				} else {
					rememberUnknownReturn();
				}
				invalidateWalletActivity(queryClient);
			} catch {
				if (!cancelled) {
					rememberUnknownReturn();
					toast.error("Couldn't refresh top-up", {
						description: "Check your connection, then check Wallet again.",
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
	}, [queryClient, rememberPendingTopUp]);

	useEffect(() => {
		if (!pendingTopUp || pendingTopUpApplied) return;
		const deadline = pendingTopUp.checkStartedAtMs + TOP_UP_CREDIT_TIMEOUT_MS;
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) {
			setTopUpCheckTimedOut(true);
			return;
		}
		let disposed = false;

		function recheckWalletCredit() {
			if (disposed || document.visibilityState !== "visible" || topUpRefetchInFlight.current) {
				return;
			}
			topUpRefetchInFlight.current = true;
			void Promise.allSettled([refetchWallet(), refetchLedger()]).finally(() => {
				topUpRefetchInFlight.current = false;
			});
		}

		recheckWalletCredit();
		const interval = window.setInterval(recheckWalletCredit, TOP_UP_CREDIT_RECHECK_INTERVAL_MS);
		const timeout = window.setTimeout(() => setTopUpCheckTimedOut(true), remainingMs);
		const handleVisibilityChange = () => {
			if (document.visibilityState !== "visible") return;
			if (Date.now() >= deadline) {
				setTopUpCheckTimedOut(true);
				return;
			}
			recheckWalletCredit();
		};
		document.addEventListener("visibilitychange", handleVisibilityChange);

		return () => {
			disposed = true;
			window.clearInterval(interval);
			window.clearTimeout(timeout);
			document.removeEventListener("visibilitychange", handleVisibilityChange);
		};
	}, [pendingTopUp, pendingTopUpApplied, refetchLedger, refetchWallet]);

	useEffect(() => {
		if (!pendingTopUp || !pendingTopUpApplied) return;
		clearPendingTopUpCredit(window.sessionStorage);
		setPendingTopUp(null);
		setTopUpCheckTimedOut(false);
		toast.success("Wallet credited", {
			description: "Your balance and Activity now include the top-up.",
		});
	}, [pendingTopUp, pendingTopUpApplied]);

	function retryPendingTopUpCheck() {
		if (!pendingTopUp) return;
		rememberPendingTopUp({ ...pendingTopUp, checkStartedAtMs: Date.now() });
	}

	const pendingTopUpNotice = pendingTopUp ? (
		<Alert>
			<CircleDollarSign aria-hidden />
			<AlertTitle>
				{pendingTopUp.providerStatus === "succeeded"
					? topUpCheckTimedOut
						? "Payment accepted; Wallet credit not confirmed"
						: "Payment accepted — confirming Wallet credit"
					: pendingTopUp.providerStatus === "processing"
						? topUpCheckTimedOut
							? "Payment is still processing"
							: "Payment processing"
						: "Payment status is unknown"}
			</AlertTitle>
			<AlertDescription className="flex flex-col items-start gap-3">
				<span>
					{pendingTopUp.providerStatus === "succeeded"
						? `${pendingTopUp.amountCents ? `${formatCents(pendingTopUp.amountCents)} was` : "Your payment was"} accepted, but the Wallet has not confirmed the credit yet. The displayed balance and Activity may not include it.`
						: pendingTopUp.providerStatus === "processing"
							? "The payment has not settled yet. The Wallet will credit it only after Stripe confirms it."
							: "We couldn't verify Stripe's final result. We're checking whether the Wallet received a credit, and we won't retry the charge."}
				</span>
				{topUpCheckTimedOut ? (
					<Button
						type="button"
						variant="outline"
						onClick={retryPendingTopUpCheck}
						disabled={wallet.isFetching || ledger.isFetching}
					>
						{wallet.isFetching || ledger.isFetching ? <Spinner /> : <RefreshCw />}
						Check Wallet again
					</Button>
				) : (
					<span className="flex items-center gap-2">
						<Spinner className="size-4" /> Checking for Wallet credit…
					</span>
				)}
			</AlertDescription>
		</Alert>
	) : null;

	if (wallet.isLoading) {
		return (
			<div data-hosted="true" className={WALLET_PAGE_CLASS}>
				<PageHeader title="Wallet" description={DESCRIPTION} actions={portalAction} />
				{pendingTopUpNotice}
				<WalletSkeleton />
			</div>
		);
	}

	if (wallet.error || !wallet.data) {
		return (
			<div data-hosted="true" className={WALLET_PAGE_CLASS}>
				<PageHeader title="Wallet" description={DESCRIPTION} actions={portalAction} />
				{pendingTopUpNotice}
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
			<PageHeader
				title="Wallet"
				description={DESCRIPTION}
				actions={topUpOpen ? undefined : portalAction}
			/>

			<TopUpDialog
				open={topUpOpen}
				onOpenChange={setTopUpOpen}
				onComplete={(status, context) => {
					rememberPendingTopUp({
						providerStatus: status,
						amountCents: context.amountCents,
						paymentStartedAtMs: context.paymentStartedAtMs,
						checkStartedAtMs: Date.now(),
					});
				}}
				presentation="inline"
			/>

			<div className={cn("space-y-6", topUpOpen && "hidden")}>
				{pendingTopUpNotice}

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

				<div id="auto-reload" className="grid gap-4 lg:grid-cols-2">
					<AutoReloadCard wallet={w} onTopUp={() => setTopUpOpen(true)} />
					{w.x402_enabled === true ? <X402Card /> : null}
				</div>

				{ledger.error && !ledgerData ? (
					<ApiErrorPanel
						normalizer={billingErrorNormalizer}
						error={ledger.error}
						title="Couldn’t load activity"
						onRetry={() => ledger.refetch()}
					/>
				) : (
					<>
						<LedgerTable
							entries={ledgerData?.items ?? []}
							isLoading={ledger.isLoading}
							hasMore={ledgerData?.has_more ?? false}
							atCap={ledgerLimit >= LEDGER_MAX_ROWS && (ledgerData?.has_more ?? false)}
							isFetchingMore={ledger.isFetching}
							onShowMore={
								ledger.error
									? undefined
									: () => setLedgerLimit((n) => Math.min(n + LEDGER_PAGE_SIZE, LEDGER_MAX_ROWS))
							}
						/>
						{ledger.error ? (
							<ApiErrorPanel
								normalizer={billingErrorNormalizer}
								error={ledger.error}
								title="Couldn’t load more activity"
								onRetry={() => void ledger.refetch()}
							/>
						) : null}
					</>
				)}
			</div>
		</div>
	);
}
