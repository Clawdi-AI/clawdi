"use client";

import { Link } from "@tanstack/react-router";
import { Gift, PartyPopper, RefreshCw, Rocket } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { billingErrorNormalizer } from "@/hosted/billing/errors";
import { formatUsdExact } from "@/hosted/billing/format";
import { useHostedDeployments, usePlans, useWalletLedger } from "@/hosted/billing/hooks";
import { largestSignupGrantUsd } from "@/hosted/billing/subscription/subscription-utils";
import { useWalletSnapshot } from "@/hosted/billing/wallet/wallet-query";

const WELCOME_GRANT_RECHECK_INTERVAL_MS = 5_000;
const WELCOME_GRANT_TIMEOUT_MS = 60_000;

/**
 * Pure-$0 welcome + signup-grant feedback.
 *
 * Renders for a new wallet user who hasn't deployed yet: it
 * confirms the welcome grant landed (reading the `grant_signup` ledger row)
 * and can point them at the deploy wizard. Returns null once the user has an
 * agent. Read failures render a retry action instead of hiding onboarding.
 */
export function WelcomeWalletCard({ showDeployAction = true }: { showDeployAction?: boolean }) {
	const wallet = useWalletSnapshot();
	const ledger = useWalletLedger(50);
	const deployments = useHostedDeployments();
	const plans = usePlans();
	const grant = ledger.data?.items.find((entry) => entry.operation === "grant_signup");
	const grantApplied = grant?.status === "applied";
	const grantPending = grant?.status === "pending";
	const hasDeployments = (deployments.data?.length ?? 0) > 0;
	const ledgerHasError = Boolean(ledger.error);
	const [grantCheckTimedOut, setGrantCheckTimedOut] = useState(false);
	const [grantCheckGeneration, setGrantCheckGeneration] = useState(0);
	const grantRefetchInFlight = useRef(false);
	const refetchLedger = ledger.refetch;

	useEffect(() => {
		if (hasDeployments || ledgerHasError || !grantPending || grantCheckTimedOut) return;
		const deadline = Date.now() + WELCOME_GRANT_TIMEOUT_MS;
		let disposed = false;

		function recheckVisibleLedger() {
			if (disposed || document.visibilityState !== "visible" || grantRefetchInFlight.current) {
				return;
			}
			grantRefetchInFlight.current = true;
			void refetchLedger()
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
			recheckVisibleLedger();
		}, WELCOME_GRANT_RECHECK_INTERVAL_MS);
		const timeout = window.setTimeout(() => setGrantCheckTimedOut(true), WELCOME_GRANT_TIMEOUT_MS);
		const handleVisibilityChange = () => {
			if (document.visibilityState !== "visible") return;
			if (Date.now() >= deadline) {
				setGrantCheckTimedOut(true);
				return;
			}
			recheckVisibleLedger();
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
		hasDeployments,
		ledgerHasError,
		refetchLedger,
	]);

	function retryGrantCheck() {
		setGrantCheckTimedOut(false);
		setGrantCheckGeneration((generation) => generation + 1);
		void refetchLedger().catch(() => undefined);
	}

	// Past onboarding — they already have at least one agent.
	if (hasDeployments) return null;
	if (ledger.isLoading || wallet.isLoading || deployments.isLoading) {
		return (
			<Card data-hosted="true" aria-label="Loading welcome balance">
				<CardContent className="flex items-center justify-between gap-4">
					<div className="flex flex-1 flex-col gap-2">
						<Skeleton className="h-5 w-56 max-w-full" />
						<Skeleton className="h-4 w-96 max-w-full" />
					</div>
					{showDeployAction ? <Skeleton className="h-9 w-32" /> : null}
				</CardContent>
			</Card>
		);
	}
	const loadError = wallet.error ?? ledger.error ?? deployments.error;
	if (loadError) {
		return (
			<Card data-hosted="true">
				<CardContent>
					<ApiErrorPanel
						normalizer={billingErrorNormalizer}
						error={loadError}
						onRetry={() => {
							if (wallet.error) void wallet.refetch();
							if (ledger.error) void ledger.refetch();
							if (deployments.error) void deployments.refetch();
						}}
						title="Couldn't load welcome balance"
					/>
				</CardContent>
			</Card>
		);
	}
	if (!wallet.data) return null;

	const configuredSignupGrantUsd = largestSignupGrantUsd(plans.data);
	const grantAmount = grant
		? formatUsdExact(grant.amount_usd.trim().replace(/^[+-]/, ""))
		: configuredSignupGrantUsd
			? formatUsdExact(configuredSignupGrantUsd)
			: null;

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
								? `You’re all set — ${grantAmount} added to your Wallet`
								: grantPending
									? grantCheckTimedOut
										? "Your welcome balance is taking longer than expected"
										: "Adding your welcome balance…"
									: "Welcome to Clawdi"}
						</p>
						<p className="text-sm text-muted-foreground">
							{grantApplied
								? "Your free Basic compute slot is ready. Deploy your first agent — managed AI is on us to start."
								: grantPending
									? grantCheckTimedOut
										? "It hasn’t appeared yet. Refresh to check again."
										: grantAmount
											? `Your ${grantAmount} welcome balance is on the way. You can deploy now; it’ll be ready in a moment.`
											: "Your welcome balance is on the way. You can deploy now; it’ll be ready in a moment."
									: "Your free Basic compute slot is ready. Deploy your first agent to get going."}
						</p>
					</div>
				</div>
				{grantPending || showDeployAction ? (
					<div className="flex flex-wrap items-center gap-2">
						{grantPending && !grantCheckTimedOut ? (
							<Spinner className="size-4 text-muted-foreground" />
						) : null}
						{grantPending && grantCheckTimedOut ? (
							<Button
								type="button"
								variant="outline"
								onClick={retryGrantCheck}
								disabled={ledger.isFetching}
							>
								{ledger.isFetching ? <Spinner /> : <RefreshCw />}
								Refresh balance
							</Button>
						) : null}
						{showDeployAction ? (
							<Button render={<Link to="/deploy" />} nativeButton={false}>
								<Rocket /> Deploy an agent
							</Button>
						) : null}
					</div>
				) : null}
			</CardContent>
		</Card>
	);
}
