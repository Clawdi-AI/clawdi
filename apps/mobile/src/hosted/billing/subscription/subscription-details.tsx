import { computeSubscriptionRecoveryPresentation } from "@clawdi/shared/api";
import { transactionsSectionClasses } from "@clawdi/shared/ui";
import {
	computeSubscriptionActionCopy as actionCopy,
	billingErrorCopy,
	billingTermLabel,
	computeSubscriptionCancellationCopy,
	computeSubscriptionCancellationSuccessCopy,
	computeSubscriptionCancelTitle,
	computeSubscriptionLifecycle,
	computeSubscriptionPlanLabel,
	formatCurrencyCents,
	formatShortDate,
	pendingComputePlanSlug,
	resolveComputeSubscriptionActions,
	scheduledPlanCancellationNotice,
	subscriptionMutationNotice,
} from "@clawdi/shared/view";
import { useQueryClient } from "@tanstack/react-query";
import CalendarX2 from "lucide-react-native/icons/calendar-x-2";
import Link2Off from "lucide-react-native/icons/link-2-off";
import RefreshCw from "lucide-react-native/icons/refresh-cw";
import { useState } from "react";
import { DetailAction } from "@/components/detail/detail-action";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { AppView } from "@/components/ui/view";
import { WebText, WebView, webView } from "@/components/ui/web-layout";
import type { Subscription } from "@/hosted/billing/format";
import { AddCreditsAction } from "@/hosted/billing/store/add-credits";
import { StoreSubscriptionPanel } from "@/hosted/billing/store/compute-store";
import {
	ComputeSubscriptionCard,
	useSubscriptionAgent,
} from "@/hosted/billing/subscription/compute-subscription-card";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { requestFailure } from "@/lib/request-failure";
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
/** Web's recovery reading: the lifecycle badge unless a payment or command state overrides it. */
function subscriptionRecovery(item: Subscription) {
	const lifecycle = computeSubscriptionLifecycle(item);
	return {
		lifecycle,
		...computeSubscriptionRecoveryPresentation(item, {
			label: lifecycle.badgeLabel,
			tone: lifecycle.badgeTone,
		}),
	};
}
function SubscriptionRecovery({ item }: { item: Subscription }) {
	const t = useI18n();
	const surfaces = useStoreSurfaces();
	const recovery = subscriptionRecovery(item);
	const recoveryAction = recovery.recoveryTarget
		? storeRecoveryAction(surfaces, recovery.recoveryTarget)
		: null;
	return (
		<AppView className="gap-2">
			{recovery.status.label !== recovery.lifecycle.badgeLabel ? (
				<Text
					accessibilityRole={recovery.hasPaymentIssue ? "alert" : undefined}
					className="text-foreground"
				>
					{recovery.status.label}
				</Text>
			) : null}
			{recovery.schedule?.at ? (
				<BillingFact label={t("billing.retries")} value={formatShortDate(recovery.schedule.at)} />
			) : recovery.schedule?.fallback ? (
				<Text className="text-muted-foreground">{recovery.schedule.fallback}</Text>
			) : null}
			{item.cancel_at_period_end ? (
				<Text className="text-muted-foreground">{t("billing.cancellation")}</Text>
			) : null}
			{item.pending_plan_slug ? (
				<BillingFact
					label={t("billing.pendingPlan")}
					value={computeSubscriptionPlanLabel(item.pending_plan_slug)}
				/>
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
			recoveryTarget: subscriptionRecovery(item).recoveryTarget,
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
				await Promise.all(
					["deployments", "billing-subscriptions", "creation-inventory", "creation-reusable"].map(
						(key) => cache.invalidateQueries({ queryKey: accountQueryKey(scope, key) }),
					),
				);
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
							cancelLabel={cancellation.dismissLabel}
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
				<AppView accessibilityRole="alert">
					<Text className="font-medium text-destructive">
						{running === "resume"
							? actionCopy.resumeFailed
							: running === "cancel_scheduled_change"
								? actionCopy.cancelScheduledChangeFailed
								: actionCopy.cancelFailed}
					</Text>
					<Text className="text-muted-foreground">
						{billingErrorCopy(requestFailure(action.failure))}
					</Text>
				</AppView>
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
	// Store builds: no card management instructions.
	const { cardBilling } = useStoreSurfaces();
	const agent = useSubscriptionAgent(item);
	if (item.funding_source === "store")
		return <StoreSubscriptionDetails item={item} onDeployment={onDeployment} />;
	return (
		<AppView className={webView(transactionsSectionClasses.section)}>
			<ComputeSubscriptionCard item={item} />
			<BillingFact
				label={t("billing.agent")}
				value={agent?.name ?? item.agent_name ?? t("billing.unknown")}
			/>
			<BillingFact label={t("billing.plan")} value={computeSubscriptionPlanLabel(item.plan_slug)} />
			<BillingFact
				label={t("billing.status")}
				value={computeSubscriptionLifecycle(item).badgeLabel}
			/>
			<SubscriptionRecovery item={item} />
			<BillingFact
				label={t("billing.price")}
				value={
					item.price_cents == null
						? t("billing.unknown")
						: formatCurrencyCents(item.price_cents, item.currency)
				}
			/>
			<BillingFact label={t("billing.term")} value={billingTermLabel(item.billing_term_months)} />
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
				value={formatShortDate(item.current_period_end)}
			/>
			{item.funding_source === "wallet" ? <Text>{t("billing.walletNotice")}</Text> : null}
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
	const agent = useSubscriptionAgent(item);
	return (
		<AppView className={webView(transactionsSectionClasses.section)}>
			<ComputeSubscriptionCard item={item} storeNotice={false} />
			<BillingFact
				label={t("billing.agent")}
				value={agent?.name ?? item.agent_name ?? t("billing.unknown")}
			/>
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
