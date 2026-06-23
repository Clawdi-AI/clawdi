"use client";

import { Check, Coins, Cpu, Rocket, Sparkles, Zap } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
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
import { Spinner } from "@/components/ui/spinner";
import { StatusBadge } from "@/components/ui/status-badge";
import { TermSwitcher } from "@/hosted/billing/components/term-switcher";
import type { Plan } from "@/hosted/billing/contracts";
import { normalizeBillingError } from "@/hosted/billing/errors";
import { billingTermSuffix, formatCentsCompact } from "@/hosted/billing/format";
import { useCheckout, usePlans, usePortal, useSubscription } from "@/hosted/billing/hooks";
import {
	handlePortalResult,
	selectOfferForTerm,
} from "@/hosted/billing/subscription/subscription-utils";
import { useActionLock } from "@/hosted/billing/use-action-lock";

function partitionPlans(plans: Plan[]): { free?: Plan; performance?: Plan } {
	return {
		free: plans.find((p) => p.price_cents === 0),
		performance: plans.find((p) => p.price_cents > 0),
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
 * The Free / Performance / AI Credits comparison, folded into the Plan tab's
 * upgrade flow (its own Pricing tab was redundant in Settings — Linear/Vercel
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
	const plansQuery = usePlans();
	const subscription = useSubscription();
	const checkout = useCheckout();
	const portal = usePortal();
	const runAction = useActionLock();
	const [internalTerm, setInternalTerm] = useState(1);
	const term = termProp ?? internalTerm;
	const setTerm = onTermChange ?? setInternalTerm;

	const { free, performance } = useMemo(
		() => partitionPlans(plansQuery.data ?? []),
		[plansQuery.data],
	);

	const currentSlug = subscription.data?.plan_slug ?? null;
	const onFree = !!free && currentSlug === free.slug;
	const onPerformance = !!performance && currentSlug === performance.slug;
	const upgradePending = checkout.isPending || portal.isPending;

	const performanceOffer = useMemo(
		() => (performance ? selectOfferForTerm(performance, term) : null),
		[performance, term],
	);

	async function startPerformanceCheckout() {
		if (!performance || subscription.isLoading) return;
		try {
			if (subscription.data) {
				handlePortalResult(
					await portal.mutateAsync({
						target_plan_slug: performance.slug,
						target_billing_term_months: term,
						confirm_upgrade: true,
					}),
					() => subscription.refetch(),
				);
				return;
			}
			const result = await checkout.mutateAsync({
				plan_slug: performance.slug,
				billing_term_months: term,
				collection_method: "charge_automatically",
				ui_mode: "hosted",
			});
			const url = result.action_url || result.checkout_url || result.invoice_url;
			if (url) window.location.href = url;
			else toast.error("Couldn’t start checkout", { description: "Please try again." });
		} catch (e) {
			toast.error("Couldn’t start upgrade", { description: normalizeBillingError(e) });
		}
	}

	if (!plansQuery.data) return null;

	const pointsPerUsd = performance?.points_per_usd ?? free?.points_per_usd ?? 1000;
	const creditsPerDollar = pointsPerUsd.toLocaleString();
	const annualOffer = performance?.offers.find((o) => o.billing_term_months === 12);

	return (
		<div data-hosted="true" className="space-y-3">
			<div>
				<h3 className="text-base font-semibold">Compare plans</h3>
				<p className="text-sm text-muted-foreground">
					Two tiers of always-on compute, plus pay-as-you-go AI Credits.
				</p>
			</div>
			<div className="grid items-start gap-4 lg:grid-cols-3">
				{/* Free */}
				<Card className="flex flex-col">
					<CardHeader>
						<div className="flex items-center justify-between">
							<CardTitle className="flex items-center gap-2">
								<Cpu className="size-5 text-muted-foreground" aria-hidden /> Free
							</CardTitle>
							{onFree ? <StatusBadge status="success">Current plan</StatusBadge> : null}
						</div>
						<div className="mt-2 flex items-baseline gap-1">
							<span className="text-3xl font-semibold tracking-tight tabular-nums">$0</span>
							<span className="text-sm text-muted-foreground">/mo</span>
						</div>
						<CardDescription className="mt-2">
							An always-on agent. Pair it with your own AI key to run end-to-end at no cost.
						</CardDescription>
					</CardHeader>
					<CardContent className="flex-1">
						<ul className="space-y-2">
							<FeatureRow>Always-on hosted runtime + TEE</FeatureRow>
							<FeatureRow>
								Burstable compute{free ? ` (${free.vcpu} vCPU / ${free.ram_gb} GB burst)` : ""}
							</FeatureRow>
							<FeatureRow>Single agent engine (OpenClaw or Hermes)</FeatureRow>
							<FeatureRow>$0 with BYOK — bring your own provider key</FeatureRow>
							<FeatureRow>$5 in AI Credits on signup</FeatureRow>
						</ul>
					</CardContent>
					<CardFooter>
						<Button
							className="w-full"
							variant="outline"
							onClick={() => router.push("/deploy")}
							disabled={onFree}
						>
							{onFree ? (
								"Your current plan"
							) : (
								<>
									<Rocket /> Deploy free
								</>
							)}
						</Button>
					</CardFooter>
				</Card>

				{/* Performance */}
				<Card className="relative flex flex-col border-primary/50 shadow-sm ring-1 ring-primary/20">
					{!onPerformance ? (
						<Badge className="-top-2.5 absolute left-1/2 -translate-x-1/2 shadow-sm">
							Recommended
						</Badge>
					) : null}
					<CardHeader>
						<div className="flex items-center justify-between">
							<CardTitle className="flex items-center gap-2">
								<Zap className="size-5 text-primary" aria-hidden /> Performance
							</CardTitle>
							{onPerformance ? <StatusBadge status="success">Current plan</StatusBadge> : null}
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
							More compute, dual engines, and higher burst for demanding agents.
							{annualOffer && annualOffer.discount_percent > 0
								? ` Save ${annualOffer.discount_percent}% on annual.`
								: ""}
						</CardDescription>
						{performance && performance.offers.length > 1 ? (
							<div className="mt-3">
								<TermSwitcher offers={performance.offers} value={term} onChange={setTerm} />
							</div>
						) : null}
					</CardHeader>
					<CardContent className="flex-1">
						<ul className="space-y-2">
							<FeatureRow>Everything in Free, plus:</FeatureRow>
							<FeatureRow>
								Higher burst
								{performance ? ` (${performance.vcpu} vCPU / ${performance.ram_gb} GB)` : ""}
							</FeatureRow>
							<FeatureRow>Run two engines at once (OpenClaw + Hermes)</FeatureRow>
							<FeatureRow>
								Larger disk{performance ? ` (${performance.disk_size} GB)` : ""}
							</FeatureRow>
							<FeatureRow>$5 in AI Credits each month</FeatureRow>
						</ul>
					</CardContent>
					<CardFooter>
						<Button
							className="w-full"
							onClick={() => runAction(startPerformanceCheckout)}
							disabled={!performance || onPerformance || subscription.isLoading || upgradePending}
						>
							{upgradePending ? (
								<>
									<Spinner /> Updating…
								</>
							) : onPerformance ? (
								"Your current plan"
							) : (
								"Upgrade to Performance"
							)}
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
								<span className="font-medium">Free with BYOK</span> — your own key bypasses managed
								AI
							</FeatureRow>
						</ul>
						<Separator className="my-4" />
						<p className="text-xs text-muted-foreground">
							Works with both Free and Performance compute. Manage balance and auto-reload from the
							Wallet.
						</p>
					</CardContent>
					<CardFooter>
						<Button
							className="w-full"
							variant="outline"
							onClick={() => router.push("/settings/billing/wallet")}
						>
							<Sparkles /> Open Wallet
						</Button>
					</CardFooter>
				</Card>
			</div>
		</div>
	);
}
