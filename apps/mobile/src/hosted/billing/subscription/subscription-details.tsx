import { computeSubscriptionRecoveryPresentation } from "@clawdi/shared/api";
import { transactionsSectionClasses } from "@clawdi/shared/ui";
import {
	billingTermLabel,
	computeSubscriptionPlanLabel,
	storeProviderLabel,
	storeSubscriptionSchedule,
} from "@clawdi/shared/view";
import { DetailAction } from "@/components/detail/detail-action";
import { Text } from "@/components/ui/text";
import { AppView } from "@/components/ui/view";
import { WebText, WebView, webView } from "@/components/ui/web-layout";
import { formatDate } from "@/hooks/cloud-inventory";
import type { Subscription } from "@/hosted/billing/format";
import { subscriptionPrice } from "@/hosted/billing/format";
import { AddCreditsAction } from "@/hosted/billing/store/add-credits";
import { StoreSubscriptionPanel } from "@/hosted/billing/store/compute-store";
import { creditPrice } from "@/hosted/billing/store/store-presentation";
import { ComputeSubscriptionCard } from "@/hosted/billing/subscription/compute-subscription-card";
import { useI18n } from "@/lib/i18n";
import { storeRecoveryAction } from "@/platform/store/store-policy";
import { useStoreSurfaces } from "@/platform/store/store-provider";

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
	const surfaces = useStoreSurfaces();
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
	const recoveryAction = recovery.recoveryTarget
		? storeRecoveryAction(surfaces, recovery.recoveryTarget)
		: null;
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
			{recoveryAction === "add_credits" ? (
				<>
					<Text className="text-muted-foreground">{t("store.walletDunning")}</Text>
					<AddCreditsAction size="sm" />
				</>
			) : recoveryAction === "card_status" ? (
				<Text className="text-muted-foreground">{t("store.cardDunning")}</Text>
			) : recoveryAction ? (
				<Text className="text-muted-foreground">
					{t(surfaces.cardBilling ? "billing.providerRecovery" : "store.recoveryStatus")}
				</Text>
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
	// Store builds: credits instead of dollars, and no card management instructions.
	const { cardBilling, creditUnits } = useStoreSurfaces();
	if (item.funding_source === "store")
		return <StoreSubscriptionDetails item={item} onDeployment={onDeployment} />;
	return (
		<AppView className={webView(transactionsSectionClasses.section)}>
			<ComputeSubscriptionCard item={item} />
			<BillingFact label={t("billing.agent")} value={item.agent_name ?? t("billing.unknown")} />
			<BillingFact label={t("billing.plan")} value={item.plan_slug} />
			<BillingFact label={t("billing.status")} value={item.status} />
			<SubscriptionRecovery item={item} />
			<BillingFact
				label={t("billing.price")}
				value={
					(creditUnits ? creditPrice(item, t("store.credits")) : subscriptionPrice(item)) ??
					t("billing.unknown")
				}
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
								? t(cardBilling ? "billing.stripe" : "store.cardSource")
								: t("billing.unknown")
				}
			/>
			<BillingFact
				label={t("billing.periodEnd")}
				value={formatDate(item.current_period_end) ?? t("billing.unknown")}
			/>
			{item.funding_source === "wallet" ? (
				<Text>{t(cardBilling ? "billing.walletNotice" : "store.walletNotice")}</Text>
			) : null}
			{cardBilling ? (
				<Text className="text-muted-foreground">{t("billing.management")}</Text>
			) : item.funding_source === "stripe" ? (
				<Text className="text-muted-foreground">{t("store.cardBillingStatus")}</Text>
			) : null}
			{item.deployment_id ? (
				<DetailAction label={t("billing.deployment")} onPress={onDeployment} />
			) : null}
		</AppView>
	);
}

/** App Store / Google Play rows: store contract facts and store actions only, never Stripe. */
function StoreSubscriptionDetails({
	item,
	onDeployment,
}: {
	item: Subscription;
	onDeployment: () => void;
}) {
	const t = useI18n();
	const management = item.store_management;
	return (
		<AppView className={webView(transactionsSectionClasses.section)}>
			<ComputeSubscriptionCard item={item} storeNotice={false} />
			<BillingFact label={t("billing.agent")} value={item.agent_name ?? t("billing.unknown")} />
			<BillingFact label={t("billing.plan")} value={computeSubscriptionPlanLabel(item.plan_slug)} />
			<BillingFact label={t("billing.term")} value={billingTermLabel(item.billing_term_months)} />
			<BillingFact label={t("billing.source")} value={storeProviderLabel(management)} />
			<BillingFact label={t("billing.periodEnd")} value={storeSubscriptionSchedule(management)} />
			{item.pending_plan_slug ? (
				<BillingFact
					label={t("billing.pendingPlan")}
					value={computeSubscriptionPlanLabel(item.pending_plan_slug)}
				/>
			) : null}
			<StoreSubscriptionPanel item={item} />
			{item.deployment_id ? (
				<DetailAction label={t("billing.deployment")} onPress={onDeployment} />
			) : null}
		</AppView>
	);
}
