"use client";

import { useRouter } from "@tanstack/react-router";
import { Gift, PartyPopper, Rocket } from "lucide-react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import type { Plan } from "@/hosted/billing/contracts";
import { billingErrorNormalizer } from "@/hosted/billing/errors";
import { creditsToUsd } from "@/hosted/billing/format";
import { useHostedDeployments, usePlans, useWallet, useWalletLedger } from "@/hosted/billing/hooks";

/**
 * Pure-$0 welcome + signup-grant feedback.
 *
 * Renders for a new wallet user who hasn't deployed yet: it
 * confirms the AI Credits grant landed (reading the `grant_signup` ledger row)
 * and points them at the deploy wizard. Returns null once the user has an
 * agent or when the v2 billing reads are unavailable.
 */
function signupGrantCredits(plans: Plan[] | undefined): number {
	return Math.max(0, ...(plans ?? []).map((plan) => plan.signup_grant_credits ?? 0));
}

export function WelcomeCreditsCard() {
	const router = useRouter();
	const wallet = useWallet();
	const ledger = useWalletLedger(50);
	const deployments = useHostedDeployments();
	const plans = usePlans();

	// Past onboarding — they already have at least one agent.
	if ((deployments.data?.length ?? 0) > 0) return null;
	if (ledger.isLoading || wallet.isLoading || deployments.isLoading) return null;
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
						title="Couldn't load welcome credits"
					/>
				</CardContent>
			</Card>
		);
	}
	if (!wallet.data) return null;

	const grant = ledger.data?.items.find((e) => e.operation === "grant_signup");
	const grantApplied = grant?.status === "applied";
	const grantPending = grant?.status === "pending";
	const configuredSignupGrantCredits = signupGrantCredits(plans.data);
	const grantCredits = grant
		? creditsToUsd(Math.abs(grant.credits_amount), wallet.data.points_per_usd)
		: configuredSignupGrantCredits > 0
			? creditsToUsd(configuredSignupGrantCredits, wallet.data.points_per_usd)
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
								? `You’re all set — ${grantCredits} in AI Credits added to your wallet`
								: grantPending
									? "Adding your welcome credits…"
									: "Welcome to Clawdi"}
						</p>
						<p className="text-sm text-muted-foreground">
							{grantApplied
								? "Your free Basic compute slot is ready. Deploy your first agent — managed AI is on us to start."
								: grantPending
									? grantCredits
										? `Your ${grantCredits} in AI Credits is on the way. You can deploy now; it’ll be ready in a moment.`
										: "Your welcome credits are on the way. You can deploy now; they’ll be ready in a moment."
									: "Your free Basic compute slot is ready. Deploy your first agent to get going."}
						</p>
					</div>
				</div>
				<div className="flex items-center gap-2">
					{grantPending ? <Spinner className="size-4 text-muted-foreground" /> : null}
					<Button onClick={() => void router.navigate({ href: "/deploy" })}>
						<Rocket /> Deploy an agent
					</Button>
				</div>
			</CardContent>
		</Card>
	);
}
