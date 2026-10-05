import type { DeployComponents } from "@clawdi/shared/api";
import { planComparisonClasses as styles, termSwitcherClasses } from "@clawdi/shared/ui";
import {
	billingTermLabel,
	cardTrialPricePresentation,
	computePlanComparisonView,
} from "@clawdi/shared/view";
import { Check, Cpu, Zap } from "lucide-react-native";
import { useState } from "react";
import { useI18n } from "../../i18n";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../card";
import { Icon } from "../icon";
import { SettingsSection } from "../settings/section";
import { Tabs, TabsList, TabsTrigger } from "../tabs";
import { Text } from "../text";
import { WebText, WebView, webView } from "../web-layout";

type Plan = DeployComponents["schemas"]["V2PlanResponse"];
export function PlanComparison({ plans }: { plans: Plan[] }) {
	const t = useI18n();
	const [term, setTerm] = useState(1);
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
	} = computePlanComparisonView(plans, term);

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
					<Tabs
						value={String(selected)}
						onValueChange={(value) => {
							const offer = common.find((item) => String(item.billing_term_months) === value);
							if (offer) setTerm(offer.billing_term_months);
						}}
					>
						<TabsList variant="default">
							{common.map((offer) => (
								<TabsTrigger
									key={offer.billing_term_months}
									value={String(offer.billing_term_months)}
									className={webView(termSwitcherClasses.item)}
								>
									<Text>{billingTermLabel(offer.billing_term_months)}</Text>
								</TabsTrigger>
							))}
						</TabsList>
					</Tabs>
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
					const trial =
						price && offer
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
												{t("billingParity.upTo")} {plan.vcpu} vCPU · {plan.ram_gb} GB RAM ·{" "}
												{plan.disk_size} GB {t("billingParity.storage")}
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
