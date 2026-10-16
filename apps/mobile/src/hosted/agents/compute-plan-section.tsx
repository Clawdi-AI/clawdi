import { computeSubscriptionRecoveryPresentation, type DeploymentRead } from "@clawdi/shared/api";
import {
	agentSettingsCopy,
	COMPUTE_BASIC_SLUG,
	COMPUTE_PERFORMANCE_SLUG,
	computeDunningState,
	computeFundingSource,
	computeSubscriptionCancelTitle,
	computeSubscriptionCardView,
	computeSubscriptionLifecycle,
	computeTierLabel,
	detachedStoreRecoveryTarget,
	formatShortDate,
	pendingComputePlanSlug,
	pendingPlanScheduleCopy,
	planChangeBillingTerm,
	resolveBasicPlan,
	resolveComputeSubscriptionActions,
	resolvePerformancePlan,
	selectExplicitOfferForTerm,
	selectOfferForTerm,
	storeSubscriptionCardView,
} from "@clawdi/shared/view";
import { SettingsSection } from "@/components/settings-section";
import { Badge } from "@/components/ui/badge";
import { Text } from "@/components/ui/text";
import { AppView } from "@/components/ui/view";
import { usePlans } from "@/hosted/billing/hooks";
import {
	StoreSubscriptionActions,
	StoreSubscriptionNotice,
	StoreUpgradeAction,
} from "@/hosted/billing/store/compute-store";
import { ComputeSubscriptionCard } from "@/hosted/billing/subscription/compute-subscription-card";
import { SubscriptionCommands } from "@/hosted/billing/subscription/subscription-row";
import { WalletTopUpAction } from "@/hosted/billing/wallet/balance-card";
import { appSubscriptionActions } from "@/platform/store/store-policy";
import { useStoreSurfaces } from "@/platform/store/store-provider";

/**
 * Web's agent Settings "Compute plan" section: the card with its inline actions. Plan changes
 * and new card/Wallet subscriptions stay on Web (C9); store builds offer their store actions.
 */
export function ComputePlanSection({ deployment }: { deployment: DeploymentRead }) {
	const plans = usePlans();
	const surfaces = useStoreSurfaces();
	const rawPlanSlug = deployment.current_plan_slug;
	const planSlug =
		rawPlanSlug === COMPUTE_BASIC_SLUG || rawPlanSlug === COMPUTE_PERFORMANCE_SLUG
			? rawPlanSlug
			: undefined;
	const subscription = deployment.commercial_display?.compute_subscription;
	const fundingSource = computeFundingSource(planSlug, subscription);
	const dunning = computeDunningState(deployment);
	const terminalRecovery = dunning?.recoveryTarget?.kind === "start_new" ? dunning : null;
	const pendingPlanSlug = pendingComputePlanSlug(subscription);
	const billingTerm = planChangeBillingTerm(subscription?.billing_term_months ?? 1);
	const paidPlan =
		planSlug === COMPUTE_BASIC_SLUG
			? resolveBasicPlan(plans.data)
			: planSlug === COMPUTE_PERFORMANCE_SLUG
				? resolvePerformancePlan(plans.data)
				: undefined;
	const offer = paidPlan
		? planSlug === COMPUTE_BASIC_SLUG
			? selectExplicitOfferForTerm(paidPlan, billingTerm)
			: selectOfferForTerm(paidPlan, billingTerm)
		: null;
	const priceCents =
		typeof subscription?.price_cents === "number"
			? subscription.price_cents
			: offer?.billingTermMonths === billingTerm
				? (offer.offer?.price_cents ?? null)
				: null;
	const endsAt = subscription?.cancel_at ?? subscription?.current_period_end ?? null;
	const periodLabel = formatShortDate(endsAt);
	const lifecycle = subscription ? computeSubscriptionLifecycle(subscription) : null;
	const recovery = computeSubscriptionRecoveryPresentation(
		subscription,
		lifecycle
			? { label: lifecycle.badgeLabel, tone: lifecycle.badgeTone }
			: { label: "Unavailable", tone: "neutral" },
	);
	const recoveryTarget =
		terminalRecovery?.recoveryTarget ??
		recovery.recoveryTarget ??
		detachedStoreRecoveryTarget(deployment);
	const store = fundingSource === "store";
	const storeManagement = store ? subscription?.store_management : null;
	const view = store
		? storeSubscriptionCardView({
				planSlug: planSlug ?? rawPlanSlug,
				billingTermMonths: billingTerm,
				management: storeManagement,
				fallbackStatus: recovery.status,
			})
		: computeSubscriptionCardView({
				status: recovery.status,
				planSlug: planSlug ?? rawPlanSlug,
				fundingSource:
					fundingSource === "included_basic"
						? "included"
						: fundingSource === "stripe" || fundingSource === "wallet"
							? fundingSource
							: "unavailable",
				priceCents,
				currency: subscription?.currency ?? "usd",
				billingTermMonths: billingTerm,
				scheduleVerb: recovery.schedule?.verb ?? lifecycle?.dateVerb ?? null,
				scheduleAt: recovery.schedule?.at ?? lifecycle?.dateAt,
				scheduleFallback: recovery.schedule?.fallback ?? undefined,
			});
	const pendingPlanCopy = pendingPlanSlug
		? pendingPlanScheduleCopy(pendingPlanSlug, subscription?.current_period_end, periodLabel)
		: null;
	const actions = resolveComputeSubscriptionActions({
		entitlement: {
			deploymentId: deployment.resource.id,
			planSlug,
			fundingSource: subscription?.funding_source,
			priceCents: subscription?.price_cents,
			status: subscription?.status ?? "unavailable",
			paymentState: subscription?.payment_state ?? "ok",
			cancelAtPeriodEnd: Boolean(subscription?.cancel_at_period_end),
			pendingPlanSlug,
			actions: subscription?.actions,
		},
		management: { action: "hidden", target: null, unavailableReason: null },
		recoveryTarget,
	});
	const commands = appSubscriptionActions(surfaces, actions);
	const hasActions =
		Boolean(storeManagement) || recoveryTarget?.kind === "top_up" || commands.length > 0;
	return (
		<SettingsSection
			title={agentSettingsCopy.computePlan.title}
			description={agentSettingsCopy.computePlan.description}
		>
			<ComputeSubscriptionCard
				view={view}
				badges={
					terminalRecovery?.fundingSource === "wallet" ? (
						<Badge variant="outline">
							<Text className="font-normal text-muted-foreground">
								{agentSettingsCopy.computePlan.walletFallback}
							</Text>
						</Badge>
					) : null
				}
				notice={
					store || pendingPlanCopy ? (
						<AppView className="gap-1">
							{store ? <StoreSubscriptionNotice management={storeManagement} /> : null}
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
							{storeManagement ? <StoreSubscriptionActions management={storeManagement} /> : null}
							{recoveryTarget?.kind === "top_up" ? <WalletTopUpAction size="sm" /> : null}
							<SubscriptionCommands
								target={{ deployment_id: deployment.resource.id }}
								kinds={commands}
								cancelTitle={computeSubscriptionCancelTitle(computeTierLabel(planSlug))}
								isTrial={subscription?.actions?.cancel === "end_trial"}
								periodEnd={endsAt}
								hasRetainedDeployment
							/>
						</>
					) : null
				}
			/>
			<StoreUpgradeAction deployment={deployment} />
		</SettingsSection>
	);
}
