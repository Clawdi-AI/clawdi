import type { DeploymentRead } from "@clawdi/shared/api";
import { computeSubscriptionRecoveryPresentation } from "@clawdi/shared/api";
import {
	type AgentTile,
	computeSubscriptionActionCopy as actionCopy,
	agentSectionHref,
	billingErrorCopy,
	computeSubscriptionAssignment,
	computeSubscriptionCancellationCopy,
	computeSubscriptionCancellationSuccessCopy,
	computeSubscriptionCancelTitle,
	computeSubscriptionCardView,
	computeSubscriptionIdentity,
	computeSubscriptionLifecycle,
	computeSubscriptionListCopy,
	computeSubscriptionPlanLabel,
	computeSubscriptionRecoveryNotice,
	formatShortDate,
	isHistoricalAccountSubscription,
	pendingComputePlanSlug,
	pendingPlanScheduleCopy,
	resolveComputeSubscriptionActions,
	scheduledPlanCancellationNotice,
	storeSubscriptionCardView,
	subscriptionMutationNotice,
} from "@clawdi/shared/view";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import CalendarX2 from "lucide-react-native/icons/calendar-x-2";
import Link2Off from "lucide-react-native/icons/link-2-off";
import RefreshCw from "lucide-react-native/icons/refresh-cw";
import Settings from "lucide-react-native/icons/settings";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { AppView } from "@/components/ui/view";
import type { Subscription } from "@/hosted/billing/format";
import {
	StoreSubscriptionActions,
	StoreSubscriptionNotice,
} from "@/hosted/billing/store/compute-store";
import { ComputeSubscriptionCard } from "@/hosted/billing/subscription/compute-subscription-card";
import { WalletTopUpAction } from "@/hosted/billing/wallet/balance-card";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { requestFailure } from "@/lib/request-failure";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";
import {
	type AppSubscriptionActionKind,
	appSubscriptionActions,
} from "@/platform/store/store-policy";
import { useStoreSurfaces } from "@/platform/store/store-provider";

/** Reads a subscription command can change. */
const SUBSCRIPTION_READS = [
	"deployments",
	"billing-subscriptions",
	"billing-reusable",
	"creation-inventory",
	"creation-reusable",
] as const;

/**
 * Web's card/Wallet commands on the card, filtered for store builds (D-1). Results show
 * under the actions, as Web's toasts would.
 */
function SubscriptionCommands({
	item,
	kinds,
}: {
	item: Subscription;
	kinds: readonly AppSubscriptionActionKind[];
}) {
	const { compute } = useMobileApi();
	const scope = useAccountScope();
	const read = useAccountRead();
	const cache = useQueryClient();
	const action = useAuthAction(scope);
	const [running, setRunning] = useState<AppSubscriptionActionKind | null>(null);
	const [notice, setNotice] = useState<{ title: string; description?: string } | null>(null);
	if (!compute || kinds.length === 0) return null;
	const isTrial = item.actions?.cancel === "end_trial";
	const hasRetainedDeployment = !item.is_orphan && item.deployment_id != null;
	const cancellation = computeSubscriptionCancellationCopy({
		isTrial,
		periodEndLabel: item.current_period_end ? formatShortDate(item.current_period_end) : null,
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
					SUBSCRIPTION_READS.map((key) =>
						cache.invalidateQueries({ queryKey: accountQueryKey(scope, key) }),
					),
				);
		});
	return (
		<>
			{kinds.map((kind) =>
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
						<Text>{kind === "resume" ? actionCopy.resume : actionCopy.cancelScheduledChange}</Text>
					</Button>
				),
			)}
			{notice ? (
				<AppView accessibilityLiveRegion="polite" className="w-full">
					<Text className="font-medium text-foreground">{notice.title}</Text>
					{notice.description ? (
						<Text className="text-muted-foreground">{notice.description}</Text>
					) : null}
				</AppView>
			) : null}
			{action.error && running ? (
				<AppView accessibilityRole="alert" className="w-full">
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
		</>
	);
}

/**
 * Web's `SubscriptionRow`: the card with its user, recovery notice, pending plan and inline
 * actions. Plan changes keep their own paths (card/Wallet changes are Web-only, C9).
 */
export function SubscriptionRow({
	item,
	deployment,
	agentTile,
	reusableSubscriptionIds,
	reusableInventoryUncertain,
}: {
	item: Subscription;
	deployment?: DeploymentRead;
	agentTile?: AgentTile;
	reusableSubscriptionIds: ReadonlySet<string>;
	reusableInventoryUncertain: boolean;
}) {
	const t = useI18n();
	const router = useRouter();
	const surfaces = useStoreSurfaces();
	const lifecycle = computeSubscriptionLifecycle(item);
	const recovery = computeSubscriptionRecoveryPresentation(item, {
		label: lifecycle.badgeLabel,
		tone: lifecycle.badgeTone,
	});
	const assignment = computeSubscriptionAssignment(item, reusableSubscriptionIds);
	const agentId = assignment === "assigned" && !item.is_orphan ? deployment?.agent_id : undefined;
	const openAgentSettings = agentId
		? () => router.push(agentSectionHref(agentId, "settings"))
		: undefined;
	const recoveryTarget =
		assignment === "available" && recovery.recoveryTarget?.kind === "start_new"
			? null
			: recovery.recoveryTarget;
	const pendingPlanSlug = pendingComputePlanSlug(item);
	const actions = resolveComputeSubscriptionActions({
		entitlement: {
			subscriptionKind: item.subscription_kind,
			deploymentId: item.deployment_id,
			planSlug: item.plan_slug,
			fundingSource: item.funding_source,
			priceCents: item.price_cents,
			status: item.status,
			paymentState: item.payment_state,
			cancelAtPeriodEnd: item.cancel_at_period_end,
			pendingPlanSlug,
			isOrphan: assignment !== "assigned",
			actions: item.actions,
		},
		management: { action: "hidden", target: null, unavailableReason: null },
		recoveryTarget,
	});
	const commands = appSubscriptionActions(surfaces, actions);
	const startNew = actions.some((candidate) => candidate.kind === "start_new")
		? openAgentSettings
		: undefined;
	const store = item.funding_source === "store";
	// Store builds can't update a card, so its recovery is a neutral status there.
	const cardRecovery = recoveryTarget?.kind === "invoice" || recoveryTarget?.kind === "fix_payment";
	const recoveryNotice =
		cardRecovery && !surfaces.cardBilling
			? t("store.cardDunning")
			: computeSubscriptionRecoveryNotice(recoveryTarget, { canStartNew: Boolean(startNew) });
	const pendingPlanCopy = pendingPlanSlug
		? pendingPlanScheduleCopy(
				pendingPlanSlug,
				item.current_period_end,
				formatShortDate(item.current_period_end),
			)
		: null;
	const view = store
		? storeSubscriptionCardView({
				planSlug: item.plan_slug,
				billingTermMonths: item.billing_term_months,
				management: item.store_management,
				fallbackStatus: recovery.status,
			})
		: computeSubscriptionCardView({
				status: recovery.status,
				planSlug: item.plan_slug,
				fundingSource:
					item.subscription_kind === "included_basic"
						? "included"
						: item.funding_source === "stripe" || item.funding_source === "wallet"
							? item.funding_source
							: "unavailable",
				priceCents: item.price_cents,
				currency: item.currency,
				billingTermMonths: item.billing_term_months,
				scheduleVerb: recovery.schedule?.verb ?? lifecycle.dateVerb,
				scheduleAt: recovery.schedule?.at ?? lifecycle.dateAt,
				scheduleFallback: recovery.schedule?.fallback ?? undefined,
				includeSchedule: !isHistoricalAccountSubscription(item),
			});
	const identity = computeSubscriptionIdentity(
		item,
		assignment,
		agentTile,
		null,
		reusableInventoryUncertain,
	);
	const hasActions =
		commands.length > 0 ||
		Boolean(startNew) ||
		recoveryTarget?.kind === "top_up" ||
		(store && item.store_management != null);
	return (
		<ComputeSubscriptionCard
			view={view}
			identity={identity}
			onOpenAgent={openAgentSettings}
			notice={
				store || recoveryNotice || pendingPlanCopy ? (
					<AppView className="gap-1.5">
						{store ? <StoreSubscriptionNotice management={item.store_management} /> : null}
						{recoveryNotice ? (
							<Text className="text-xs text-muted-foreground">{recoveryNotice}</Text>
						) : null}
						{pendingPlanCopy ? (
							<Text className="text-xs font-medium text-warning-muted-foreground">
								{pendingPlanCopy}
							</Text>
						) : null}
					</AppView>
				) : null
			}
			actions={
				hasActions ? (
					<>
						{store && item.store_management ? (
							<StoreSubscriptionActions management={item.store_management} />
						) : null}
						{recoveryTarget?.kind === "top_up" ? <WalletTopUpAction size="sm" /> : null}
						{startNew ? (
							<Button variant="outline" size="sm" onPress={startNew}>
								<Icon as={Settings} />
								<Text>{computeSubscriptionListCopy.openAgentSettings}</Text>
							</Button>
						) : null}
						<SubscriptionCommands item={item} kinds={commands} />
					</>
				) : null
			}
		/>
	);
}
