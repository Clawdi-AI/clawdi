import { computeSubscriptionRecoveryPresentation } from "@clawdi/shared/api";
import { transactionsSectionClasses } from "@clawdi/shared/ui";
import {
	computeSubscriptionActionCopy as actionCopy,
	computeSubscriptionCancellationCopy,
	computeSubscriptionCancellationSuccessCopy,
	computeSubscriptionCancelTitle,
	computeSubscriptionPlanLabel,
	formatShortDate,
	pendingComputePlanSlug,
	resolveComputeSubscriptionActions,
	scheduledPlanCancellationNotice,
	subscriptionMutationNotice,
} from "@clawdi/shared/view";
import { useQueryClient } from "@tanstack/react-query";
import { CalendarX2, Link2Off, RefreshCw } from "lucide-react-native";
import { useState } from "react";
import { DetailAction } from "@/components/detail/detail-action";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { Icon } from "@/components/ui/icon";
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
import { useMobileApi } from "@/lib/api-provider";
import { type Translator, useI18n } from "@/lib/i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";
import {
	type AppSubscriptionActionKind,
	appSubscriptionActions,
	storeRecoveryAction,
} from "@/platform/store/store-policy";
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
function subscriptionRecovery(item: Subscription, t: Translator) {
	return computeSubscriptionRecoveryPresentation(
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
}
function SubscriptionRecovery({ item }: { item: Subscription }) {
	const t = useI18n();
	const surfaces = useStoreSurfaces();
	const recovery = subscriptionRecovery(item, t);
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

/**
 * Web's card/Wallet subscription commands, filtered for store builds (D-1). Nothing here
 * purchases; plan changes keep their existing path.
 */
function SubscriptionActions({ item }: { item: Subscription }) {
	const t = useI18n();
	const surfaces = useStoreSurfaces();
	const { compute } = useMobileApi();
	const scope = useAccountScope();
	const read = useAccountRead();
	const cache = useQueryClient();
	const action = useAuthAction(scope);
	const [running, setRunning] = useState<AppSubscriptionActionKind | null>(null);
	const [notice, setNotice] = useState<{ title: string; description?: string } | null>(null);
	const actions = appSubscriptionActions(
		surfaces,
		resolveComputeSubscriptionActions({
			entitlement: {
				subscriptionKind: item.subscription_kind,
				deploymentId: item.deployment_id,
				planSlug: item.plan_slug,
				fundingSource: item.funding_source,
				priceCents: item.price_cents,
				status: item.status,
				paymentState: item.payment_state,
				cancelAtPeriodEnd: item.cancel_at_period_end,
				pendingPlanSlug: pendingComputePlanSlug(item),
				isOrphan: item.is_orphan,
				actions: item.actions,
			},
			management: { action: "hidden", target: null, unavailableReason: null },
			recoveryTarget: subscriptionRecovery(item, t).recoveryTarget,
		}),
	);
	if (!compute || actions.length === 0) return null;
	const isTrial = item.actions?.cancel === "end_trial";
	const hasRetainedDeployment = !item.is_orphan && item.deployment_id != null;
	const periodEnd = item.current_period_end ? formatShortDate(item.current_period_end) : null;
	const cancellation = computeSubscriptionCancellationCopy({
		isTrial,
		periodEndLabel: periodEnd,
		hasRetainedDeployment,
	});
	const target = { subscription_id: item.subscription_id };
	const execute = (kind: AppSubscriptionActionKind) =>
		action.runOrThrow(async (current) => {
			setRunning(kind);
			setNotice(null);
			if (kind === "cancel_scheduled_change") {
				const result = await read((s) => compute.cancelScheduledPlanChange(target, s));
				if (current()) setNotice(scheduledPlanCancellationNotice(result));
			} else if (kind === "resume") {
				const result = await read((s) => compute.resumeSubscription(target, s));
				if (current()) setNotice(subscriptionMutationNotice(result, "resume"));
			} else {
				const result = await read((s) => compute.cancelSubscription(target, s));
				if (current())
					setNotice(
						subscriptionMutationNotice(
							result,
							"cancel",
							computeSubscriptionCancellationSuccessCopy({
								isTrial,
								cancelAtPeriodEnd: result.cancel_at_period_end,
								periodEndLabel: result.current_period_end
									? formatShortDate(result.current_period_end)
									: null,
								hasRetainedDeployment,
							}),
						),
					);
			}
			if (current())
				await cache.invalidateQueries({
					queryKey: accountQueryKey(scope, "billing-subscriptions"),
				});
		});
	return (
		<AppView className="gap-2">
			<AppView className="flex-row flex-wrap gap-2">
				{actions.map((kind) =>
					kind === "cancel" || kind === "end_trial" ? (
						<ConfirmAction
							key={kind}
							title={computeSubscriptionCancelTitle(computeSubscriptionPlanLabel(item.plan_slug))}
							description={cancellation.description}
							confirmLabel={cancellation.confirmLabel}
							destructive
							onConfirm={() => execute(kind)}
						>
							<Button variant="outline" size="sm" disabled={action.busy}>
								<Icon as={Link2Off} />
								<Text>{kind === "end_trial" ? actionCopy.endTrial : actionCopy.cancel}</Text>
							</Button>
						</ConfirmAction>
					) : (
						<Button
							key={kind}
							variant="outline"
							size="sm"
							disabled={action.busy}
							onPress={() => void execute(kind).catch(() => undefined)}
						>
							<Icon as={kind === "resume" ? RefreshCw : CalendarX2} />
							<Text>
								{kind === "resume" ? actionCopy.resume : actionCopy.cancelScheduledChange}
							</Text>
						</Button>
					),
				)}
			</AppView>
			{notice ? (
				<AppView accessibilityLiveRegion="polite">
					<Text className="font-medium text-foreground">{notice.title}</Text>
					{notice.description ? (
						<Text className="text-muted-foreground">{notice.description}</Text>
					) : null}
				</AppView>
			) : null}
			{action.error && running ? (
				<Text accessibilityRole="alert" className="text-destructive">
					{running === "resume"
						? actionCopy.resumeFailed
						: running === "cancel_scheduled_change"
							? actionCopy.cancelScheduledChangeFailed
							: actionCopy.cancelFailed}
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
			<SubscriptionActions item={item} />
			{item.deployment_id ? (
				<DetailAction label={t("billing.deployment")} onPress={onDeployment} />
			) : null}
		</AppView>
	);
}

/**
 * App Store / Google Play rows: the card already shows plan, term, store and schedule;
 * add only the Agent, a pending plan and store actions, never Stripe.
 */
function StoreSubscriptionDetails({
	item,
	onDeployment,
}: {
	item: Subscription;
	onDeployment: () => void;
}) {
	const t = useI18n();
	return (
		<AppView className={webView(transactionsSectionClasses.section)}>
			<ComputeSubscriptionCard item={item} storeNotice={false} />
			<BillingFact label={t("billing.agent")} value={item.agent_name ?? t("billing.unknown")} />
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
