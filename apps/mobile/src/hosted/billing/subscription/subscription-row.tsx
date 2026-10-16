import type { ComputeSubscriptionTarget, DeploymentRead } from "@clawdi/shared/api";
import { computeSubscriptionRecoveryPresentation } from "@clawdi/shared/api";
import {
	type AgentTile,
	type AppComputeAction,
	computeSubscriptionActionCopy as actionCopy,
	agentSectionHref,
	appComputeActions,
	billingErrorCopy,
	computeSubscriptionAssignment,
	computeSubscriptionCancellationCopy,
	computeSubscriptionCancellationSuccessCopy,
	computeSubscriptionCancelTitle,
	computeSubscriptionCardView,
	computeSubscriptionIdentity,
	computeSubscriptionLifecycle,
	computeSubscriptionListCopy,
	computeSubscriptionManagement,
	computeSubscriptionPlanLabel,
	computeSubscriptionRecoveryNotice,
	formatShortDate,
	isHistoricalAccountSubscription,
	pendingComputePlanSlug,
	pendingPlanScheduleCopy,
	resolveComputeSubscriptionActions,
	resolvePerformancePlan,
	scheduledPlanCancellationNotice,
	storeSubscriptionCardView,
	subscriptionMutationNotice,
} from "@clawdi/shared/view";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import ArrowUp from "lucide-react-native/icons/arrow-up";
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
import { useProductCapabilities } from "@/hooks/use-dashboard-agents";
import type { Subscription } from "@/hosted/billing/format";
import { usePlans } from "@/hosted/billing/hooks";
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
import { useStoreSurfaces } from "@/platform/store/store-provider";

/** Card/Wallet commands run in place; plan changes and new subscriptions open their sheets. */
export type AppSubscriptionActionKind = Extract<
	AppComputeAction["kind"],
	"cancel" | "end_trial" | "resume" | "cancel_scheduled_change"
>;

function isCommand(kind: AppComputeAction["kind"]): kind is AppSubscriptionActionKind {
	return (
		kind === "cancel" ||
		kind === "end_trial" ||
		kind === "resume" ||
		kind === "cancel_scheduled_change"
	);
}

/**
 * Web's `ComputeSubscriptionActionList` for the app: Upgrade/Manage and Check status open
 * the plan sheet, "Choose a subscription" opens the subscription sheet, and the rest run
 * in place through `SubscriptionCommands`.
 */
export function ComputeSubscriptionActions({
	actions,
	agentId,
	startNewLabel,
	startNewViaSettings = false,
	commandTarget,
	cancelTitle,
	isTrial,
	periodEnd,
	hasRetainedDeployment,
}: {
	actions: readonly AppComputeAction[];
	agentId: string | null | undefined;
	startNewLabel: string;
	/** The Compute list opens the Agent's Settings first, like Web's start-new link. */
	startNewViaSettings?: boolean;
	commandTarget: ComputeSubscriptionTarget;
	cancelTitle: string;
	isTrial: boolean;
	periodEnd: string | null | undefined;
	hasRetainedDeployment: boolean;
}) {
	const router = useRouter();
	const openSheet = (sheet: "plan" | "subscription") => {
		if (!agentId) return;
		if (sheet === "subscription" && startNewViaSettings)
			router.push(agentSectionHref(agentId, "settings"));
		router.push({ pathname: `/agents/[id]/${sheet}`, params: { id: agentId } });
	};
	return (
		<>
			{actions.map((action) => {
				const disabled = !agentId || action.disabledReason !== null;
				switch (action.kind) {
					case "upgrade":
					case "manage":
						return (
							<Button
								key={action.kind}
								variant="outline"
								size="sm"
								disabled={disabled}
								onPress={() => openSheet("plan")}
							>
								<Icon as={action.kind === "upgrade" ? ArrowUp : Settings} />
								<Text>{action.kind === "upgrade" ? actionCopy.upgrade : actionCopy.manage}</Text>
							</Button>
						);
					case "check_change":
						return (
							<Button
								key={action.kind}
								variant="outline"
								size="sm"
								disabled={disabled}
								onPress={() => openSheet("plan")}
							>
								<Icon as={RefreshCw} />
								<Text>{actionCopy.checkChange}</Text>
							</Button>
						);
					case "start_new":
						return (
							<Button
								key={action.kind}
								size="sm"
								disabled={disabled}
								onPress={() => openSheet("subscription")}
							>
								<Icon as={Settings} />
								<Text>{startNewLabel}</Text>
							</Button>
						);
					default:
						return null;
				}
			})}
			<SubscriptionCommands
				target={commandTarget}
				kinds={actions.map((action) => action.kind).filter(isCommand)}
				cancelTitle={cancelTitle}
				isTrial={isTrial}
				periodEnd={periodEnd}
				hasRetainedDeployment={hasRetainedDeployment}
			/>
		</>
	);
}

/** Reads a subscription command can change. */
const SUBSCRIPTION_READS = [
	"deployments",
	"deployment",
	"billing-subscriptions",
	"billing-reusable",
	"creation-inventory",
	"creation-reusable",
] as const;

/**
 * Web's card/Wallet commands on the card, filtered for store builds (D-1). Results show
 * under the actions, as Web's toasts would.
 */
export function SubscriptionCommands({
	target,
	kinds,
	cancelTitle,
	isTrial,
	periodEnd,
	hasRetainedDeployment,
}: {
	target: ComputeSubscriptionTarget;
	kinds: readonly AppSubscriptionActionKind[];
	cancelTitle: string;
	isTrial: boolean;
	periodEnd: string | null | undefined;
	hasRetainedDeployment: boolean;
}) {
	const { compute } = useMobileApi();
	const scope = useAccountScope();
	const read = useAccountRead();
	const cache = useQueryClient();
	const action = useAuthAction(scope);
	const [running, setRunning] = useState<AppSubscriptionActionKind | null>(null);
	const [notice, setNotice] = useState<{ title: string; description?: string } | null>(null);
	if (!compute || kinds.length === 0) return null;
	const cancellation = computeSubscriptionCancellationCopy({
		isTrial,
		periodEndLabel: periodEnd ? formatShortDate(periodEnd) : null,
		hasRetainedDeployment,
	});
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
						title={cancelTitle}
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
 * actions, filtered for store builds by the shared store billing policy.
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
	const plans = usePlans();
	const capabilities = useProductCapabilities();
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
	const deploymentBound = assignment === "assigned";
	// Web's per-row management: plan changes open the Agent's plan sheet.
	const management = computeSubscriptionManagement({
		entitlement: {
			subscriptionKind: item.subscription_kind,
			deploymentId: item.deployment_id,
			planSlug: item.plan_slug,
			fundingSource: item.funding_source,
			priceCents: item.price_cents,
			billingTermMonths: item.billing_term_months,
			status: item.status,
			paymentState: item.payment_state,
			cancelAtPeriodEnd: item.cancel_at_period_end,
			recoveryAction: item.recovery_action,
			pendingPlanSlug,
			isOrphan: item.is_orphan,
		},
		deployment,
		canCreateCloudAgents: capabilities.data?.can_use_v2 === true,
		plansLoading: plans.isPending,
		performancePlanAvailable: Boolean(resolvePerformancePlan(plans.data)),
	});
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
			isOrphan: !deploymentBound,
			actions: item.actions,
		},
		management,
		recoveryTarget,
		hasPendingOperation: deploymentBound && management.target?.projectedOperationName != null,
	});
	const appActions = appComputeActions(
		!surfaces.cardBilling,
		{ fundingSource: item.funding_source },
		actions,
	);
	// Web's start-new link exists only for a bound row with a known Agent.
	const startNew =
		appActions.some((candidate) => candidate.kind === "start_new") && Boolean(agentId);
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
	const managementReason = deploymentBound ? management.unavailableReason : null;
	const visibleActions = appActions.filter(
		(candidate) => candidate.kind !== "start_new" || startNew,
	);
	const hasActions =
		visibleActions.length > 0 ||
		recoveryTarget?.kind === "top_up" ||
		(store && item.store_management != null);
	return (
		<ComputeSubscriptionCard
			view={view}
			identity={identity}
			onOpenAgent={openAgentSettings}
			notice={
				store || recoveryNotice || pendingPlanCopy || managementReason ? (
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
						{managementReason ? (
							<Text className="text-xs text-muted-foreground">{managementReason}</Text>
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
						<ComputeSubscriptionActions
							actions={visibleActions}
							agentId={agentId}
							startNewLabel={computeSubscriptionListCopy.openAgentSettings}
							startNewViaSettings
							commandTarget={{ subscription_id: item.subscription_id }}
							cancelTitle={computeSubscriptionCancelTitle(
								computeSubscriptionPlanLabel(item.plan_slug),
							)}
							isTrial={item.actions?.cancel === "end_trial"}
							periodEnd={item.current_period_end}
							hasRetainedDeployment={!item.is_orphan && item.deployment_id != null}
						/>
					</>
				) : null
			}
		/>
	);
}
