import { computeSubscriptionRecoveryPresentation } from "@clawdi/shared/api";
import { transactionsSectionClasses } from "@clawdi/shared/ui";
import type { Subscription } from "../../features/billing/helpers";
import { subscriptionPrice } from "../../features/billing/helpers";
import { formatDate } from "../../features/cloud-inventory";
import { useI18n } from "../../i18n";
import { ClerkAction as DetailAction } from "../auth/clerk-form";
import { Text } from "../text";
import { AppView } from "../view";
import { WebText, WebView, webView } from "../web-layout";
import { ComputeSubscriptionCard } from "./compute-subscription-card";

function BillingFact({ label, value }: { label: string; value: string }) {
	return (
		<WebView recipe={transactionsSectionClasses.mobileCopy}>
			<WebText recipe={transactionsSectionClasses.description}>{label}</WebText>
			<WebText selectable recipe={transactionsSectionClasses.label}>
				{value}
			</WebText>
		</WebView>
	);
}
function SubscriptionRecovery({ item }: { item: Subscription }) {
	const t = useI18n();
	const recovery = computeSubscriptionRecoveryPresentation(
		item,
		{ label: item.status, tone: "neutral" },
		{
			updating: t("billing.updating"),
			processing: t("billing.processing"),
			unpaid: t("billing.unpaid"),
			actionRequired: t("billing.actionRequired"),
			pastDue: t("billing.pastDue"),
			paymentProcessing: t("billing.paymentProcessing"),
			attention: t("billing.attention"),
			awaitingPayment: t("billing.awaitingPayment"),
			support: t("billing.support"),
			ended: t("billing.ended"),
			paymentAttention: t("billing.paymentAttention"),
		},
	);
	return (
		<AppView className="gap-2">
			{recovery.status.label !== item.status ? (
				<Text
					accessibilityRole={recovery.hasPaymentIssue ? "alert" : undefined}
					className="text-foreground"
				>
					{recovery.status.label}
				</Text>
			) : null}
			{recovery.schedule?.at ? (
				<BillingFact
					label={t("billing.retries")}
					value={formatDate(recovery.schedule.at) ?? t("billing.unknown")}
				/>
			) : recovery.schedule?.fallback ? (
				<Text className="text-muted-foreground">{recovery.schedule.fallback}</Text>
			) : null}
			{item.cancel_at_period_end ? (
				<Text className="text-muted-foreground">{t("billing.cancellation")}</Text>
			) : null}
			{item.pending_plan_slug ? (
				<BillingFact label={t("billing.pendingPlan")} value={item.pending_plan_slug} />
			) : null}
			{recovery.recoveryTarget ? (
				<Text className="text-muted-foreground">{t("billing.providerRecovery")}</Text>
			) : null}
		</AppView>
	);
}

export function SubscriptionDetails({
	item,
	onDeployment,
}: {
	item: Subscription;
	onDeployment: () => void;
}) {
	const t = useI18n();
	return (
		<AppView className={webView(transactionsSectionClasses.section)}>
			<ComputeSubscriptionCard item={item} />
			<BillingFact label={t("billing.agent")} value={item.agent_name ?? t("billing.unknown")} />
			<BillingFact label={t("billing.plan")} value={item.plan_slug} />
			<BillingFact label={t("billing.status")} value={item.status} />
			<SubscriptionRecovery item={item} />
			<BillingFact
				label={t("billing.price")}
				value={subscriptionPrice(item) ?? t("billing.unknown")}
			/>
			<BillingFact label={t("billing.term")} value={String(item.billing_term_months)} />
			<BillingFact
				label={t("billing.source")}
				value={
					item.subscription_kind === "included_basic"
						? t("billing.included")
						: item.funding_source === "wallet"
							? t("billing.wallet")
							: item.funding_source === "stripe"
								? t("billing.stripe")
								: t("billing.unknown")
				}
			/>
			<BillingFact
				label={t("billing.periodEnd")}
				value={formatDate(item.current_period_end) ?? t("billing.unknown")}
			/>
			{item.funding_source === "wallet" ? <Text>{t("billing.walletNotice")}</Text> : null}
			<Text className="text-muted-foreground">{t("billing.management")}</Text>
			{item.deployment_id ? (
				<DetailAction label={t("billing.deployment")} onPress={onDeployment} />
			) : null}
		</AppView>
	);
}
