"use client";

import { Link } from "@tanstack/react-router";
import { Gift, PartyPopper, Rocket } from "lucide-react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import type { Plan } from "@/hosted/billing/contracts";
import { billingErrorNormalizer } from "@/hosted/billing/errors";
import { formatUsdExact } from "@/hosted/billing/format";
import { useHostedDeployments, usePlans, useWallet, useWalletLedger } from "@/hosted/billing/hooks";

/**
 * Pure-$0 welcome + signup-grant feedback.
 *
 * Renders for a new wallet user who hasn't deployed yet: it
 * confirms the welcome grant landed (reading the `grant_signup` ledger row)
 * and points them at the deploy wizard. Returns null once the user has an
 * agent. Read failures render a retry action instead of hiding onboarding.
 */
function signupGrantUsd(plans: Plan[] | undefined): string {
	return (plans ?? []).reduce(
		(largest, plan) =>
			Number(plan.signup_grant_usd) > Number(largest) ? plan.signup_grant_usd : largest,
		"0",
	);
}

export function WelcomeWalletCard() {
	const wallet = useWallet();
	const ledger = useWalletLedger(50);
	const deployments = useHostedDeployments();
	const plans = usePlans();

	// Past onboarding — they already have at least one agent.
	if ((deployments.data?.length ?? 0) > 0) return null;
	if (ledger.isLoading || wallet.isLoading || deployments.isLoading) {
		return (
			<Card data-hosted="true" aria-label="Loading welcome balance">
				<CardContent className="flex items-center justify-between gap-4">
					<div className="flex flex-1 flex-col gap-2">
						<Skeleton className="h-5 w-56 max-w-full" />
						<Skeleton className="h-4 w-96 max-w-full" />
					</div>
					<Skeleton className="h-9 w-32" />
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

	const grant = ledger.data?.items.find((e) => e.operation === "grant_signup");
	const grantApplied = grant?.status === "applied";
	const grantPending = grant?.status === "pending";
	const configuredSignupGrantUsd = signupGrantUsd(plans.data);
	const grantAmount = grant
		? formatUsdExact(grant.amount_usd.trim().replace(/^[+-]/, ""))
		: Number(configuredSignupGrantUsd) > 0
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
									? "Adding your welcome balance…"
									: "Welcome to Clawdi"}
						</p>
						<p className="text-sm text-muted-foreground">
							{grantApplied
								? "Your free Basic compute slot is ready. Deploy your first agent — managed AI is on us to start."
								: grantPending
									? grantAmount
										? `Your ${grantAmount} welcome balance is on the way. You can deploy now; it’ll be ready in a moment.`
										: "Your welcome balance is on the way. You can deploy now; it’ll be ready in a moment."
									: "Your free Basic compute slot is ready. Deploy your first agent to get going."}
						</p>
					</div>
				</div>
				<div className="flex items-center gap-2">
					{grantPending ? <Spinner className="size-4 text-muted-foreground" /> : null}
					<Button render={<Link to="/deploy" />} nativeButton={false}>
						<Rocket /> Deploy an agent
					</Button>
				</div>
			</CardContent>
		</Card>
	);
}
