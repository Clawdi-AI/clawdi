"use client";

import { Check, Cpu, Zap } from "lucide-react";
import { useMemo } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { SettingsSection } from "@/components/settings-section";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { TermSwitcher } from "@/hosted/billing/components/term-switcher";
import type { Plan } from "@/hosted/billing/contracts";
import { computePricePresentation } from "@/hosted/billing/deploy/deploy-price-presentation";
import { billingErrorNormalizer } from "@/hosted/billing/errors";
import { usePlans } from "@/hosted/billing/hooks";
import {
	commonExplicitBillingOffers,
	explicitPlanOffers,
	resolveBasicPlan,
	resolvePerformancePlan,
} from "@/hosted/billing/subscription/subscription-utils";
import { shouldBlockQueryError } from "@/lib/query-state";

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
 * Basic and Performance are the two comparable compute plans. Managed AI is
 * wallet-funded usage, so it belongs in Wallet and Usage instead of a third,
 * semantically mismatched pricing card.
 */
export function PlanComparison({
	term,
	onTermChange,
}: {
	term: number;
	onTermChange: (term: number) => void;
}) {
	const plansQuery = usePlans();

	const { basic, performance } = useMemo(
		() => partitionPlans(plansQuery.data ?? []),
		[plansQuery.data],
	);

	if (plansQuery.isLoading) {
		return (
			<SettingsSection headingLevel={3} title="Plans" description="Compare hosted compute plans.">
				<div className="grid gap-3 lg:grid-cols-2">
					<Skeleton className="h-72 w-full rounded-lg" />
					<Skeleton className="h-72 w-full rounded-lg" />
				</div>
			</SettingsSection>
		);
	}

	if (shouldBlockQueryError(plansQuery.error, plansQuery.data)) {
		return (
			<SettingsSection headingLevel={3} title="Plans" description="Compare hosted compute plans.">
				<ApiErrorPanel
					normalizer={billingErrorNormalizer}
					error={plansQuery.error}
					onRetry={() => void plansQuery.refetch()}
					title="Couldn't load plans"
				/>
			</SettingsSection>
		);
	}

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
		<SettingsSection
			data-hosted="true"
			headingLevel={3}
			title="Plans"
			actions={
				commonOffers.length > 1 && selectedTerm !== null ? (
					<div className="w-56">
						<TermSwitcher
							offers={commonOffers}
							value={selectedTerm}
							onChange={onTermChange}
							showDiscount={false}
							ariaLabel="Billing term for Basic and Performance"
						/>
					</div>
				) : null
			}
			description={
				sharedPricingUnavailable
					? "A shared Basic and Performance billing term is not currently available."
					: "Compare hosted compute plans before starting another agent."
			}
		>
			<div>
				<div className="grid gap-3 lg:grid-cols-2">
					{/* Basic */}
					<Card size="sm">
						<CardHeader className="gap-2">
							<CardTitle className="flex items-center gap-2">
								<Cpu className="size-5 text-muted-foreground" aria-hidden /> Compute Basic
							</CardTitle>
							<CardDescription>First active Basic agent included at no charge.</CardDescription>
							<div className="min-h-20 pt-1">
								<p className="text-xs text-muted-foreground">Each additional Basic agent</p>
								{basicPrice ? (
									<>
										<p className="text-3xl font-semibold tracking-tight tabular-nums">
											{basicPrice.primary}
										</p>
										<p className="text-xs text-muted-foreground">{basicPrice.secondary}</p>
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
					</Card>

					{/* Performance */}
					<Card size="sm" className="border-primary/30">
						<CardHeader className="gap-2">
							<CardTitle className="flex items-center gap-2">
								<Zap className="size-5 text-primary" aria-hidden /> Compute Performance
							</CardTitle>
							<CardDescription>Higher capacity for production workloads.</CardDescription>
							<div className="min-h-20 pt-1">
								<p className="text-xs text-muted-foreground">Each Performance agent</p>
								{performancePrice ? (
									<>
										<p className="text-3xl font-semibold tracking-tight tabular-nums">
											{performancePrice.primary}
										</p>
										<p className="text-xs text-muted-foreground">{performancePrice.secondary}</p>
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
					</Card>
				</div>
			</div>
		</SettingsSection>
	);
}
