"use client";

import { planComparisonClasses } from "@clawdi/shared/ui";
import { billingCopy, computePlanComparisonView } from "@clawdi/shared/view";
import { Check, Cpu, Zap } from "lucide-react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { SettingsSection } from "@/components/settings-section";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { TermSwitcher } from "@/hosted/billing/components/term-switcher";
import type { BillingOffer } from "@/hosted/billing/contracts";
import {
	type ComputePricePresentation,
	cardTrialPricePresentation,
} from "@/hosted/billing/deploy/deploy-price-presentation";
import { billingErrorNormalizer } from "@/hosted/billing/errors";
import { usePlans } from "@/hosted/billing/hooks";
import { shouldBlockQueryError } from "@/lib/query-state";

function FeatureRow({ children }: { children: React.ReactNode }) {
	return (
		<li className={planComparisonClasses.feature}>
			<Check className={planComparisonClasses.featureIcon} aria-hidden />
			<span>{children}</span>
		</li>
	);
}

function PlanPrice({
	offer,
	presentation,
}: {
	offer: BillingOffer;
	presentation: ComputePricePresentation;
}) {
	const trial = cardTrialPricePresentation(presentation.primary, offer.card_trial_period_days);
	return (
		<>
			<p className={planComparisonClasses.price}>{presentation.primary}</p>
			<p className={planComparisonClasses.unit}>{trial?.label ?? presentation.secondary}</p>
			{trial && offer.billing_term_months > 1 ? (
				<p className={planComparisonClasses.unit}>{presentation.secondary}</p>
			) : null}
		</>
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

	if (plansQuery.isLoading) {
		return (
			<SettingsSection headingLevel={3} title="Plans" description="Compare hosted compute plans.">
				<div className={planComparisonClasses.grid}>
					<Skeleton className={planComparisonClasses.skeletonCard} />
					<Skeleton className={planComparisonClasses.skeletonCard} />
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

	const {
		basic,
		performance,
		commonOffers,
		selectedTerm,
		basicOffer,
		performanceOffer,
		basicPrice,
		performancePrice,
		sharedPricingUnavailable,
	} = computePlanComparisonView(plansQuery.data ?? [], term);

	return (
		<SettingsSection
			data-hosted="true"
			headingLevel={3}
			title="Plans"
			actions={
				commonOffers.length > 1 && selectedTerm !== null ? (
					<div className={planComparisonClasses.skeletonTitle}>
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
					? billingCopy.sharedPricingUnavailable
					: "Compare hosted compute plans."
			}
		>
			<div>
				<div className={planComparisonClasses.grid}>
					{/* Basic */}
					<Card size="sm">
						<CardHeader className={planComparisonClasses.header}>
							<CardTitle className={planComparisonClasses.title}>
								<Cpu className={planComparisonClasses.icon} aria-hidden /> Compute Basic
							</CardTitle>
							<CardDescription>Balanced capacity for everyday workloads.</CardDescription>
							<div className={planComparisonClasses.priceBlock}>
								<p className={planComparisonClasses.description}>Basic subscription</p>
								{basicPrice && basicOffer ? (
									<PlanPrice offer={basicOffer} presentation={basicPrice} />
								) : (
									<p className={planComparisonClasses.subheading}>Pricing unavailable</p>
								)}
							</div>
						</CardHeader>
						<CardContent className={planComparisonClasses.stretch}>
							<ul className={planComparisonClasses.features}>
								{basic ? (
									<FeatureRow>
										Up to {basic.vcpu} vCPU · {basic.ram_gb} GB RAM · {basic.disk_size} GB storage
									</FeatureRow>
								) : null}
								<FeatureRow>Managed confidential compute · choose OpenClaw or Hermes</FeatureRow>
								<FeatureRow>Bring your own API key (BYOK) · pay your provider directly</FeatureRow>
							</ul>
						</CardContent>
					</Card>

					{/* Performance */}
					<Card size="sm" className={planComparisonClasses.featuredCard}>
						<CardHeader className={planComparisonClasses.header}>
							<CardTitle className={planComparisonClasses.title}>
								<Zap className={planComparisonClasses.featuredIcon} aria-hidden /> Compute
								Performance
							</CardTitle>
							<CardDescription>Higher capacity for production workloads.</CardDescription>
							<div className={planComparisonClasses.priceBlock}>
								<p className={planComparisonClasses.description}>Performance subscription</p>
								{performancePrice && performanceOffer ? (
									<PlanPrice offer={performanceOffer} presentation={performancePrice} />
								) : (
									<p className={planComparisonClasses.subheading}>Pricing unavailable</p>
								)}
							</div>
						</CardHeader>
						<CardContent className={planComparisonClasses.stretch}>
							<ul className={planComparisonClasses.features}>
								{performance ? (
									<FeatureRow>
										Up to {performance.vcpu} vCPU · {performance.ram_gb} GB RAM ·{" "}
										{performance.disk_size} GB storage
									</FeatureRow>
								) : null}
								<FeatureRow>Managed confidential compute · choose OpenClaw or Hermes</FeatureRow>
								<FeatureRow>Bring your own API key (BYOK) · pay your provider directly</FeatureRow>
							</ul>
						</CardContent>
					</Card>
				</div>
			</div>
		</SettingsSection>
	);
}
