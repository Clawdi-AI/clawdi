import type { DeployComponents } from "@clawdi/shared/api";
import { planComparisonClasses as styles } from "@clawdi/shared/ui";
import {
	billingTermLabel,
	cardTrialPricePresentation,
	computePlanComparisonView,
} from "@clawdi/shared/view";
import { Check, Cpu, Zap } from "lucide-react-native";
import { useState } from "react";
import { SettingsSection } from "@/components/settings/settings-panel-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { AppView } from "@/components/ui/view";
import { WebText, WebView, webView } from "@/components/ui/web-layout";
import { formatCreditCents } from "@/hosted/billing/store/store-presentation";
import { useI18n } from "@/lib/i18n";
import { NativeSegments } from "@/platform/navigation/segmented-control";
import { useStoreSurfaces } from "@/platform/store/store-provider";

type Plan = DeployComponents["schemas"]["V2PlanResponse"];
export function PlanComparison({ plans }: { plans: Plan[] }) {
	const t = useI18n();
	const [term, setTerm] = useState(1);
	const { creditUnits } = useStoreSurfaces();
	const {
		basic,
		performance,
		commonOffers: common,
		selectedTerm: selected,
		basicOffer,
		performanceOffer,
		basicPrice,
		performancePrice,
		sharedPricingUnavailable,
	} = computePlanComparisonView(
		plans,
		term,
		creditUnits ? (cents) => formatCreditCents(cents, t("store.credits")) : undefined,
	);

	return (
		<SettingsSection
			title={t("billingParity.plans")}
			description={t(
				sharedPricingUnavailable
					? "billingParity.sharedPricingUnavailable"
					: "billingParity.plansDescription",
			)}
			actions={
				common.length > 1 ? (
					// The actions row sizes to content; the native control needs the full width.
					<AppView className="w-full">
						<NativeSegments
							value={String(selected)}
							options={common.map((offer) => ({
								value: String(offer.billing_term_months),
								label: billingTermLabel(offer.billing_term_months),
							}))}
							onChange={(value) => {
								const offer = common.find((item) => String(item.billing_term_months) === value);
								if (offer) setTerm(offer.billing_term_months);
							}}
						/>
					</AppView>
				) : null
			}
		>
			<WebView recipe={styles.grid}>
				{(
					[
						{ plan: basic, kind: "basic", icon: Cpu },
						{ plan: performance, kind: "performance", icon: Zap },
					] as const
				).map(({ plan, kind, icon }) => {
					const offer = kind === "basic" ? basicOffer : performanceOffer;
					const price = kind === "basic" ? basicPrice : performancePrice;
					// Card trials have no store purchase equivalent.
					const trial =
						price && offer && !creditUnits
							? cardTrialPricePresentation(price.primary, offer.card_trial_period_days)
							: null;
					return (
						<Card
							key={kind}
							size="sm"
							className={kind === "performance" ? webView(styles.featuredCard) : undefined}
						>
							<CardHeader className={webView(styles.header)}>
								<WebView recipe={styles.title} className="flex-row">
									<Icon
										as={icon}
										className={kind === "basic" ? styles.icon : styles.featuredIcon}
									/>
									<CardTitle>
										{t(kind === "basic" ? "billingParity.basic" : "billingParity.performance")}
									</CardTitle>
								</WebView>
								<CardDescription>
									{t(
										kind === "basic"
											? "billingParity.basicDescription"
											: "billingParity.performanceDescription",
									)}
								</CardDescription>
								<WebView recipe={styles.priceBlock}>
									<WebText recipe={styles.description}>
										{t(
											kind === "basic"
												? "billingParity.basicSubscription"
												: "billingParity.performanceSubscription",
										)}
									</WebText>
									<WebText recipe={price ? styles.price : styles.subheading}>
										{price?.primary ?? t("billingParity.pricingUnavailable")}
									</WebText>
									{price ? (
										<>
											<WebText recipe={styles.unit}>{trial?.label ?? price.secondary}</WebText>
											{trial && offer && offer.billing_term_months > 1 ? (
												<WebText recipe={styles.unit}>{price.secondary}</WebText>
											) : null}
										</>
									) : null}
								</WebView>
							</CardHeader>
							<CardContent>
								<WebView recipe={styles.features}>
									{plan ? (
										<WebView recipe={styles.feature} className="flex-row">
											<Icon as={Check} className={styles.featureIcon} />
											<WebText recipe={styles.feature}>
												{t("billingParity.upTo")} {plan.vcpu} {t("billing.cpuSeparator")}{" "}
												{plan.ram_gb} {t("billing.ramSeparator")} {plan.disk_size} {t("billing.gb")}{" "}
												{t("billingParity.storage")}
											</WebText>
										</WebView>
									) : null}
									{(["billingParity.confidentialCompute", "billingParity.byok"] as const).map(
										(copy) => (
											<WebView key={copy} recipe={styles.feature} className="flex-row">
												<Icon as={Check} className={styles.featureIcon} />
												<WebText recipe={styles.feature} className="flex-1">
													{t(copy)}
												</WebText>
											</WebView>
										),
									)}
								</WebView>
							</CardContent>
						</Card>
					);
				})}
			</WebView>
		</SettingsSection>
	);
}
