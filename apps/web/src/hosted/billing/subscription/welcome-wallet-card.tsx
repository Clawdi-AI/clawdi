"use client";

import { welcomeWalletCardClasses as styles } from "@clawdi/shared/ui";
import {
	welcomeWalletCopy as copy,
	WELCOME_GRANT_RECHECK_INTERVAL_MS,
	WELCOME_GRANT_TIMEOUT_MS,
	welcomeWalletDescription,
	welcomeWalletTitle,
} from "@clawdi/shared/view";
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
import { useWalletSnapshot } from "@/hosted/billing/wallet/wallet-query";
import { shouldBlockQueryError } from "@/lib/query-state";

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
			<Card data-hosted="true" aria-label={copy.loading}>
				<CardContent>
					<div className={styles.skeletonBody}>
						<Skeleton className={styles.skeletonTitle} />
						<Skeleton className={styles.skeletonLine} />
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
						title={copy.loadError}
					/>
				</CardContent>
			</Card>
		);
	}
	if (!wallet.data) return null;

	const grantAmount = grant ? formatUsdExact(grant.amount) : null;
	const state = { grantApplied, grantPending, grantCheckTimedOut, grantAmount };
	const description = welcomeWalletDescription(state);

	return (
		<Card data-hosted="true" className={styles.card}>
			<CardContent className={styles.content}>
				<div className={styles.summary}>
					<div className={styles.icon}>{grantApplied ? <PartyPopper /> : <Gift />}</div>
					<div className={styles.body}>
						<p className={styles.title}>{welcomeWalletTitle(state)}</p>
						<p className={styles.description}>{description}</p>
					</div>
				</div>
				{grantPending ? (
					<div className={styles.actions}>
						{grantPending && !grantCheckTimedOut ? <Spinner className={styles.spinner} /> : null}
						{grantPending && grantCheckTimedOut ? (
							<Button
								type="button"
								variant="outline"
								onClick={() => void retryGrantCheck()}
								disabled={manualRefreshing}
							>
								{manualRefreshing ? <Spinner /> : <RefreshCw />}
								{copy.refresh}
							</Button>
						) : null}
					</div>
				) : null}
			</CardContent>
		</Card>
	);
}
