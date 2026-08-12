"use client";

import { Gift, PartyPopper, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { billingErrorNormalizer } from "@/hosted/billing/errors";
import { formatUsdExact } from "@/hosted/billing/format";
import { useWalletTransactions } from "@/hosted/billing/hooks";
import { welcomeWalletDescription } from "@/hosted/billing/subscription/welcome-wallet-card.logic";
import { useWalletSnapshot } from "@/hosted/billing/wallet/wallet-query";
import { shouldBlockQueryError } from "@/lib/query-state";

const WELCOME_GRANT_RECHECK_INTERVAL_MS = 5_000;
const WELCOME_GRANT_TIMEOUT_MS = 60_000;

/**
 * Pure-$0 welcome + signup-grant feedback.
 *
 * Confirms that a new user's welcome grant landed by reading the
 * `grant_signup` transaction. Its parent only mounts it after the unified agent
 * inventory has authoritatively resolved empty. Read failures render a retry
 * action instead of hiding onboarding.
 */
export function WelcomeWalletCard() {
	const wallet = useWalletSnapshot();
	const transactions = useWalletTransactions();
	const grant = transactions.data?.pages
		.flatMap((page) => page.items)
		.find((entry) => entry.kind === "grant_signup");
	const grantApplied = grant?.status === "applied";
	const grantPending = grant?.status === "pending";
	const blockingWalletError = shouldBlockQueryError(wallet.error, wallet.data)
		? wallet.error
		: null;
	const blockingTransactionsError = shouldBlockQueryError(transactions.error, transactions.data)
		? transactions.error
		: null;
	const transactionsHaveError = Boolean(blockingTransactionsError);
	const [grantCheckTimedOut, setGrantCheckTimedOut] = useState(false);
	const [grantCheckGeneration, setGrantCheckGeneration] = useState(0);
	const [manualRefreshing, setManualRefreshing] = useState(false);
	const grantRefetchInFlight = useRef(false);
	const refetchTransactions = transactions.refetch;

	useEffect(() => {
		if (transactionsHaveError || !grantPending || grantCheckTimedOut) return;
		const deadline = Date.now() + WELCOME_GRANT_TIMEOUT_MS;
		let disposed = false;

		function recheckVisibleTransactions() {
			if (disposed || document.visibilityState !== "visible" || grantRefetchInFlight.current) {
				return;
			}
			grantRefetchInFlight.current = true;
			void refetchTransactions()
				.catch(() => undefined)
				.finally(() => {
					grantRefetchInFlight.current = false;
				});
		}

		const interval = window.setInterval(() => {
			if (Date.now() >= deadline) {
				setGrantCheckTimedOut(true);
				return;
			}
			recheckVisibleTransactions();
		}, WELCOME_GRANT_RECHECK_INTERVAL_MS);
		const timeout = window.setTimeout(() => setGrantCheckTimedOut(true), WELCOME_GRANT_TIMEOUT_MS);
		const handleVisibilityChange = () => {
			if (document.visibilityState !== "visible") return;
			if (Date.now() >= deadline) {
				setGrantCheckTimedOut(true);
				return;
			}
			recheckVisibleTransactions();
		};
		document.addEventListener("visibilitychange", handleVisibilityChange);

		return () => {
			disposed = true;
			window.clearInterval(interval);
			window.clearTimeout(timeout);
			document.removeEventListener("visibilitychange", handleVisibilityChange);
		};
	}, [
		grantCheckGeneration,
		grantCheckTimedOut,
		grantPending,
		refetchTransactions,
		transactionsHaveError,
	]);

	async function retryGrantCheck() {
		if (manualRefreshing) return;
		setGrantCheckTimedOut(false);
		setGrantCheckGeneration((generation) => generation + 1);
		setManualRefreshing(true);
		try {
			await refetchTransactions();
		} finally {
			setManualRefreshing(false);
		}
	}

	if (transactions.isLoading || wallet.isLoading) {
		return (
			<Card data-hosted="true" aria-label="Loading welcome balance">
				<CardContent>
					<div className="flex flex-1 flex-col gap-2">
						<Skeleton className="h-5 w-56 max-w-full" />
						<Skeleton className="h-4 w-96 max-w-full" />
					</div>
				</CardContent>
			</Card>
		);
	}
	const loadError = blockingWalletError ?? blockingTransactionsError;
	if (loadError) {
		return (
			<Card data-hosted="true">
				<CardContent>
					<ApiErrorPanel
						normalizer={billingErrorNormalizer}
						error={loadError}
						onRetry={() => {
							if (blockingWalletError) void wallet.refetch();
							if (blockingTransactionsError) void transactions.refetch();
						}}
						title="Couldn't load welcome balance"
					/>
				</CardContent>
			</Card>
		);
	}
	if (!wallet.data) return null;

	const grantAmount = grant ? formatUsdExact(grant.amount) : null;
	const description = welcomeWalletDescription({
		grantApplied,
		grantPending,
		grantCheckTimedOut,
		grantAmount,
	});

	return (
		<Card data-hosted="true" className="border-primary/30 bg-primary/5">
			<CardContent className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
				<div className="flex items-start gap-3">
					<div className="mt-0.5 text-primary [&>svg]:size-6">
						{grantApplied ? <PartyPopper /> : <Gift />}
					</div>
					<div className="space-y-1">
						<p className="font-medium">
							{grantApplied
								? grantAmount
									? `You’re all set — ${grantAmount} added to your Wallet`
									: "You’re all set — your welcome balance was added to your Wallet"
								: grantPending
									? grantCheckTimedOut
										? "Your welcome balance is taking longer than expected"
										: "Adding your welcome balance…"
									: "Welcome to Clawdi"}
						</p>
						<p className="text-sm text-muted-foreground">{description}</p>
					</div>
				</div>
				{grantPending ? (
					<div className="flex flex-wrap items-center gap-2">
						{grantPending && !grantCheckTimedOut ? (
							<Spinner className="size-4 text-muted-foreground" />
						) : null}
						{grantPending && grantCheckTimedOut ? (
							<Button
								type="button"
								variant="outline"
								onClick={() => void retryGrantCheck()}
								disabled={manualRefreshing}
							>
								{manualRefreshing ? <Spinner /> : <RefreshCw />}
								Refresh balance
							</Button>
						) : null}
					</div>
				) : null}
			</CardContent>
		</Card>
	);
}
