"use client";

import { useLocation, useRouter } from "@tanstack/react-router";
import { Check, Coins, Cpu, Rocket, Sparkles, Zap } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { TermSwitcher } from "@/hosted/billing/components/term-switcher";
import type { Plan } from "@/hosted/billing/contracts";
import { billingTermSuffix, creditsToUsd, formatCentsCompact } from "@/hosted/billing/format";
import { usePlans } from "@/hosted/billing/hooks";
import {
	explicitPlanOffers,
	planOffers,
	resolveBasicPlan,
	resolvePerformancePlan,
	selectExplicitOfferForTerm,
	selectOfferForTerm,
} from "@/hosted/billing/subscription/subscription-utils";
import { useActionLock } from "@/hosted/billing/use-action-lock";
import { settingsQueryHref } from "@/lib/settings-routes";

function partitionPlans(plans: Plan[]): { basic?: Plan; performance?: Plan } {
	return {
		basic: resolveBasicPlan(plans),
		performance: resolvePerformancePlan(plans),
	};
}

function FeatureRow({ children }: { children: React.ReactNode }) {
	return (
		<li className="flex items-start gap-2 text-sm">
			<Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
			<span>{children}</span>
		</li>
	);
}

/**
 * The Basic / Performance / AI Credits comparison, folded into the Plan tab's
 * deploy flow (its own Pricing tab was redundant in Settings — Linear/Vercel
 * keep Plan + Usage). Self-contained; safe to drop below the current-plan card.
 */
export function PlanComparison({
	term: termProp,
	onTermChange,
}: {
	/** When provided, the billing term is controlled by the parent so the
	 * page's other TermSwitchers stay in sync (no two desynced toggles). */
	term?: number;
	onTermChange?: (term: number) => void;
} = {}) {
	const router = useRouter();
	const searchStr = useLocation({ select: (location) => location.searchStr });
	const searchParams = new URLSearchParams(searchStr);
	const plansQuery = usePlans();
	const runAction = useActionLock();
	const [internalTerm, setInternalTerm] = useState(1);
	const term = termProp ?? internalTerm;
	const setTerm = onTermChange ?? setInternalTerm;

	const { basic, performance } = useMemo(
		() => partitionPlans(plansQuery.data ?? []),
		[plansQuery.data],
	);

	const performanceOfferSelection = useMemo(
		() => (performance ? selectOfferForTerm(performance, term) : null),
		[performance, term],
	);
	const performanceOffer = performanceOfferSelection?.offer ?? null;
	const performanceBillingTermMonths = performanceOfferSelection?.billingTermMonths ?? term;
	const basicOfferSelection = useMemo(
		() => (basic ? selectExplicitOfferForTerm(basic, term) : null),
		[basic, term],
	);
	const basicOffer = basicOfferSelection?.offer ?? null;
	const basicBillingTermMonths = basicOfferSelection?.billingTermMonths ?? term;

	async function startPerformanceCheckout() {
		if (!performance) return;
		void router.navigate({ href: "/deploy" });
	}

	if (!plansQuery.data) return null;

	const pointsPerUsd = performance?.points_per_usd ?? basic?.points_per_usd ?? 1000;
	const creditsPerDollar = pointsPerUsd.toLocaleString();
	const signupGrantCredits = Math.max(
		0,
		basic?.signup_grant_credits ?? performance?.signup_grant_credits ?? 0,
	);
	const subscriptionGrantCredits = Math.max(0, performance?.subscription_grant_credits ?? 0);
	const basicSubscriptionGrantCredits = Math.max(0, basic?.subscription_grant_credits ?? 0);
	const basicOffers = basic ? explicitPlanOffers(basic) : [];
	const basicResources = basic;
	const performanceOffers = performance ? planOffers(performance) : [];
	const annualOffer = performanceOffers.find((o) => o.billing_term_months === 12);

	return (
		<div data-hosted="true" className="space-y-3">
			<div>
				<h3 className="text-base font-semibold">Compare compute options</h3>
				<p className="text-sm text-muted-foreground">
					Basic includes the first active agent. Additional Basic and Performance agents are billed
					separately.
				</p>
			</div>
			<div className="grid items-start gap-4 lg:grid-cols-3">
				{/* Basic */}
				<Card className="flex flex-col">
					<CardHeader>
						<div className="flex items-center justify-between">
							<CardTitle className="flex items-center gap-2">
								<Cpu className="size-5 text-muted-foreground" aria-hidden /> Basic
							</CardTitle>
						</div>
						<div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
							<span className="text-2xl font-semibold tracking-tight">First agent free</span>
							<span className="text-sm text-muted-foreground">
								{basicOffer
									? `then ${formatCentsCompact(basicOffer.effective_monthly_price_cents)}/mo`
									: "additional pricing unavailable"}
							</span>
						</div>
						<CardDescription className="mt-2">
							One active Basic agent is included. Each additional Basic agent uses its own
							subscription.
						</CardDescription>
						{basicOffer && basicOffer.billing_term_months !== 1 ? (
							<p className="text-xs text-muted-foreground">
								Additional agents billed {formatCentsCompact(basicOffer.price_cents)}
								{billingTermSuffix(basicOffer.billing_term_months)}
							</p>
						) : null}
						{basicOffers.length > 1 ? (
							<div className="mt-3">
								<TermSwitcher
									offers={basicOffers}
									value={basicBillingTermMonths}
									onChange={setTerm}
								/>
							</div>
						) : null}
					</CardHeader>
					<CardContent className="flex-1">
						<ul className="space-y-2">
							<FeatureRow>Always-on hosted runtime + TEE</FeatureRow>
							<FeatureRow>
								Burstable compute
								{basicResources
									? ` (${basicResources.vcpu} vCPU / ${basicResources.ram_gb} GB burst)`
									: ""}
							</FeatureRow>
							<FeatureRow>One free active Basic agent per user</FeatureRow>
							<FeatureRow>Paid additional Basic agents</FeatureRow>
							<FeatureRow>Single agent engine (OpenClaw or Hermes)</FeatureRow>
							<FeatureRow>BYOK avoids managed-AI usage charges</FeatureRow>
							{basicSubscriptionGrantCredits > 0 ? (
								<FeatureRow>
									{creditsToUsd(basicSubscriptionGrantCredits, pointsPerUsd)} in AI Credits per
									subscription
								</FeatureRow>
							) : null}
							{signupGrantCredits > 0 ? (
								<FeatureRow>
									{creditsToUsd(signupGrantCredits, pointsPerUsd)} in AI Credits on signup
								</FeatureRow>
							) : null}
						</ul>
					</CardContent>
					<CardFooter>
						<Button
							className="w-full"
							variant="outline"
							onClick={() => void router.navigate({ href: "/deploy" })}
						>
							<Rocket /> Deploy Basic agent
						</Button>
					</CardFooter>
				</Card>

				{/* Performance */}
				<Card className="relative flex flex-col border-primary/50 shadow-sm ring-1 ring-primary/20">
					<Badge className="-top-2.5 absolute left-1/2 -translate-x-1/2 shadow-sm">Per agent</Badge>
					<CardHeader>
						<div className="flex items-center justify-between">
							<CardTitle className="flex items-center gap-2">
								<Zap className="size-5 text-primary" aria-hidden /> Performance
							</CardTitle>
						</div>
						<div className="mt-2 flex items-baseline gap-1">
							<span className="text-3xl font-semibold tracking-tight tabular-nums">
								{performanceOffer
									? formatCentsCompact(performanceOffer.effective_monthly_price_cents)
									: performance
										? formatCentsCompact(performance.price_cents)
										: "—"}
							</span>
							<span className="text-sm text-muted-foreground">/mo</span>
							{performanceOffer && performanceOffer.billing_term_months !== 1 ? (
								<span className="ml-1 text-xs text-muted-foreground">
									billed {formatCentsCompact(performanceOffer.price_cents)}
									{billingTermSuffix(performanceOffer.billing_term_months)}
								</span>
							) : null}
						</div>
						<CardDescription className="mt-2">
							More compute, larger disk, and public-port entitlement for demanding agents.
							{annualOffer && annualOffer.discount_percent > 0
								? ` Save ${annualOffer.discount_percent}% on annual.`
								: ""}
						</CardDescription>
						{performanceOffers.length > 1 ? (
							<div className="mt-3">
								<TermSwitcher
									offers={performanceOffers}
									value={performanceBillingTermMonths}
									onChange={setTerm}
								/>
							</div>
						) : null}
					</CardHeader>
					<CardContent className="flex-1">
						<ul className="space-y-2">
							<FeatureRow>Everything in Basic, plus:</FeatureRow>
							<FeatureRow>
								Higher burst
								{performance ? ` (${performance.vcpu} vCPU / ${performance.ram_gb} GB)` : ""}
							</FeatureRow>
							<FeatureRow>One subscription per Performance agent</FeatureRow>
							<FeatureRow>Public-port entitlement for runtime-owned services</FeatureRow>
							<FeatureRow>
								Larger disk{performance ? ` (${performance.disk_size} GB)` : ""}
							</FeatureRow>
							{subscriptionGrantCredits > 0 ? (
								<FeatureRow>
									{creditsToUsd(subscriptionGrantCredits, pointsPerUsd)} in AI Credits added to
									Wallet; credits do not expire
								</FeatureRow>
							) : null}
						</ul>
					</CardContent>
					<CardFooter>
						<Button
							className="w-full"
							onClick={() => runAction(startPerformanceCheckout)}
							disabled={!performance}
						>
							Deploy Performance agent
						</Button>
					</CardFooter>
				</Card>

				{/* AI Credits */}
				<Card className="flex flex-col bg-muted/30">
					<CardHeader>
						<CardTitle className="flex items-center gap-2">
							<Coins className="size-5 text-muted-foreground" aria-hidden /> AI Credits
						</CardTitle>
						<div className="mt-2 flex items-baseline gap-1">
							<span className="text-3xl font-semibold tracking-tight">Pay as you go</span>
						</div>
						<CardDescription className="mt-2">
							Managed AI billed by usage. Top up your wallet and spend only what your agents use.
						</CardDescription>
					</CardHeader>
					<CardContent className="flex-1">
						<ul className="space-y-2">
							<FeatureRow>
								<span className="font-medium">$1 = {creditsPerDollar} credits</span>, billed per use
							</FeatureRow>
							<FeatureRow>Top up any amount, $10–$2,000</FeatureRow>
							<FeatureRow>Optional auto-reload so agents never stall</FeatureRow>
							<FeatureRow>
								<span className="font-medium">No managed-AI charge with BYOK</span> — your own key
								bypasses managed AI
							</FeatureRow>
						</ul>
						<Separator className="my-4" />
						<p className="text-xs text-muted-foreground">
							Works with both Basic and Performance compute. Manage balance and auto-reload from the
							Wallet.
						</p>
					</CardContent>
					<CardFooter>
						<Button
							className="w-full"
							variant="outline"
							onClick={() =>
								void router.navigate({ href: settingsQueryHref("billing-wallet", searchParams) })
							}
						>
							<Sparkles /> Open Wallet
						</Button>
					</CardFooter>
				</Card>
			</div>
		</div>
	);
}
