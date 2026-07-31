"use client";

import { Link, useLocation } from "@tanstack/react-router";
import { Check, Cpu, Rocket, Sparkles, WalletCards, Zap } from "lucide-react";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { TermSwitcher } from "@/hosted/billing/components/term-switcher";
import type { Plan } from "@/hosted/billing/contracts";
import { computePricePresentation } from "@/hosted/billing/deploy/deploy-price-presentation";
import { usePlans } from "@/hosted/billing/hooks";
import {
	commonExplicitBillingOffers,
	explicitPlanOffers,
	resolveBasicPlan,
	resolvePerformancePlan,
} from "@/hosted/billing/subscription/subscription-utils";
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
 * The Basic / Performance / managed-AI comparison, folded into the Plan tab's
 * deploy flow (its own Pricing tab was redundant in Settings — Linear/Vercel
 * keep Plan + Usage). Billing-term state is controlled by the page so the
 * single selector updates both compute cards together.
 */
export function PlanComparison({
	term,
	onTermChange,
	canCreateCloudAgents = false,
}: {
	term: number;
	onTermChange: (term: number) => void;
	canCreateCloudAgents?: boolean;
}) {
	const searchStr = useLocation({ select: (location) => location.searchStr });
	const searchParams = new URLSearchParams(searchStr);
	const plansQuery = usePlans();

	const { basic, performance } = useMemo(
		() => partitionPlans(plansQuery.data ?? []),
		[plansQuery.data],
	);

	if (!plansQuery.data) return null;

	const basicOffers = basic ? explicitPlanOffers(basic) : [];
	const performanceOffers = performance ? explicitPlanOffers(performance) : [];
	const commonOffers =
		basic && performance ? commonExplicitBillingOffers([basic, performance]) : [];
	const selectedTerm =
		commonOffers.find((offer) => offer.billing_term_months === term)?.billing_term_months ??
		commonOffers[0]?.billing_term_months ??
		null;
	const basicOffer =
		selectedTerm === null
			? null
			: (basicOffers.find((offer) => offer.billing_term_months === selectedTerm) ?? null);
	const performanceOffer =
		selectedTerm === null
			? null
			: (performanceOffers.find((offer) => offer.billing_term_months === selectedTerm) ?? null);
	const basicPrice = basicOffer ? computePricePresentation(basicOffer, basicOffers) : null;
	const performancePrice = performanceOffer
		? computePricePresentation(performanceOffer, performanceOffers)
		: null;
	const sharedPricingUnavailable =
		basic !== undefined && performance !== undefined && !selectedTerm;

	return (
		<section data-hosted="true" className="space-y-4" aria-labelledby="plan-comparison-heading">
			<div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
				<div>
					<h3 id="plan-comparison-heading" className="text-base font-semibold">
						Compare compute options
					</h3>
					{sharedPricingUnavailable ? (
						<p className="mt-1 text-sm text-muted-foreground">
							A shared Basic and Performance billing term is not currently available.
						</p>
					) : null}
				</div>
				{commonOffers.length > 1 && selectedTerm !== null ? (
					<div className="w-full shrink-0 space-y-1.5 sm:w-64">
						<p className="text-xs font-medium text-muted-foreground">
							Billing term for Basic + Performance
						</p>
						<TermSwitcher
							offers={commonOffers}
							value={selectedTerm}
							onChange={onTermChange}
							showDiscount={false}
							ariaLabel="Billing term for Basic and Performance"
						/>
					</div>
				) : null}
			</div>
			<div className="grid gap-3 lg:grid-cols-3">
				{/* Basic */}
				<Card size="sm">
					<CardHeader className="gap-2">
						<CardTitle className="flex items-center gap-2">
							<Cpu className="size-5 text-muted-foreground" aria-hidden /> Compute Basic
						</CardTitle>
						<CardDescription>First active Basic agent included at no charge.</CardDescription>
						<div className="pt-1">
							<p className="text-xs text-muted-foreground">Each additional Basic agent</p>
							{basicPrice ? (
								<>
									<p className="text-3xl font-semibold tracking-tight tabular-nums">
										{basicPrice.primary}
									</p>
									{basicOffer?.billing_term_months !== 1 ? (
										<p className="text-xs text-muted-foreground">{basicPrice.secondary}</p>
									) : null}
								</>
							) : (
								<p className="text-sm font-medium">Pricing unavailable</p>
							)}
						</div>
					</CardHeader>
					<CardContent className="flex-1">
						<ul className="space-y-2">
							{basic ? (
								<FeatureRow>
									Up to {basic.vcpu} vCPU · {basic.ram_gb} GB RAM · {basic.disk_size} GB storage
								</FeatureRow>
							) : null}
							<FeatureRow>
								Managed confidential compute · one runtime (OpenClaw or Hermes)
							</FeatureRow>
							<FeatureRow>BYOK bypasses Clawdi AI charges</FeatureRow>
						</ul>
					</CardContent>
					<CardFooter>
						{canCreateCloudAgents ? (
							<Button
								render={<Link to="/deploy" />}
								nativeButton={false}
								className="w-full"
								variant="outline"
							>
								<Rocket /> Deploy Compute Basic
							</Button>
						) : (
							<Button className="w-full" variant="outline" disabled>
								<Rocket /> Deploy Compute Basic
							</Button>
						)}
					</CardFooter>
				</Card>

				{/* Performance */}
				<Card size="sm" className="border-primary/30">
					<CardHeader className="gap-2">
						<CardTitle className="flex items-center gap-2">
							<Zap className="size-5 text-primary" aria-hidden /> Compute Performance
						</CardTitle>
						<div className="pt-1">
							<p className="text-xs text-muted-foreground">Each Performance agent</p>
							{performancePrice ? (
								<>
									<p className="text-3xl font-semibold tracking-tight tabular-nums">
										{performancePrice.primary}
									</p>
									{performanceOffer?.billing_term_months !== 1 ? (
										<p className="text-xs text-muted-foreground">{performancePrice.secondary}</p>
									) : null}
								</>
							) : (
								<p className="text-sm font-medium">Pricing unavailable</p>
							)}
						</div>
					</CardHeader>
					<CardContent className="flex-1">
						<ul className="space-y-2">
							{performance ? (
								<FeatureRow>
									Up to {performance.vcpu} vCPU · {performance.ram_gb} GB RAM ·{" "}
									{performance.disk_size} GB storage
								</FeatureRow>
							) : null}
							<FeatureRow>
								Managed confidential compute · one runtime (OpenClaw or Hermes)
							</FeatureRow>
							<FeatureRow>BYOK bypasses Clawdi AI charges</FeatureRow>
						</ul>
					</CardContent>
					<CardFooter>
						{canCreateCloudAgents ? (
							<Button
								render={<Link to="/deploy" />}
								nativeButton={false}
								className="w-full"
								disabled={!performance}
							>
								Deploy Compute Performance
							</Button>
						) : (
							<Button className="w-full" disabled>
								Deploy Compute Performance
							</Button>
						)}
					</CardFooter>
				</Card>

				{/* Clawdi AI */}
				<Card size="sm" className="bg-muted/20">
					<CardHeader className="gap-2">
						<CardTitle className="flex items-center gap-2">
							<WalletCards className="size-5 text-muted-foreground" aria-hidden /> Clawdi AI
						</CardTitle>
						<div className="pt-1">
							<p className="text-3xl font-semibold tracking-tight">Pay as you go</p>
						</div>
					</CardHeader>
					<CardContent className="flex-1">
						<ul className="space-y-2">
							<FeatureRow>
								30% cheaper than direct API pricing on supported models. Actual savings vary by
								model.
							</FeatureRow>
							<FeatureRow>Pay from your Wallet</FeatureRow>
							<FeatureRow>BYOK bypasses Clawdi AI charges</FeatureRow>
						</ul>
					</CardContent>
					<CardFooter>
						<Button
							render={<Link to={settingsQueryHref("billing-wallet", searchParams)} />}
							nativeButton={false}
							className="w-full"
							variant="outline"
						>
							<Sparkles /> Open Wallet
						</Button>
					</CardFooter>
				</Card>
			</div>
		</section>
	);
}
