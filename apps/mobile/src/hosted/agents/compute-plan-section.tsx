import type { DeploymentRead } from "@clawdi/shared/api";
import {
	agentSettingsCopy,
	appComputeActions,
	COMPUTE_BASIC_SLUG,
	COMPUTE_PERFORMANCE_SLUG,
	computeSubscriptionCancelTitle,
	computeSubscriptionCardView,
	computeTierLabel,
	formatShortDate,
	pendingPlanScheduleCopy,
	resolveBasicPlan,
	resolvePerformancePlan,
	selectExplicitOfferForTerm,
	selectOfferForTerm,
	storeSubscriptionCardView,
} from "@clawdi/shared/view";
import { SettingsSection } from "@/components/settings-section";
import { Badge } from "@/components/ui/badge";
import { Text } from "@/components/ui/text";
import { AppView } from "@/components/ui/view";
import { useComputePlanModel } from "@/hosted/agents/compute-plan-model";
import {
	StoreSubscriptionActions,
	StoreSubscriptionNotice,
	StoreUpgradeAction,
} from "@/hosted/billing/store/compute-store";
import { ComputeSubscriptionCard } from "@/hosted/billing/subscription/compute-subscription-card";
import { ComputeSubscriptionActions } from "@/hosted/billing/subscription/subscription-row";
import { WalletTopUpAction } from "@/hosted/billing/wallet/balance-card";
import { useStoreSurfaces } from "@/platform/store/store-provider";

/**
 * Web's agent Settings "Compute plan" section: the card with its inline actions. Upgrade,
 * Manage and Check status open the plan sheet; "Choose a subscription" opens the
 * subscription sheet. Store builds keep their store actions and the shared store policy.
 */
export function ComputePlanSection({ deployment }: { deployment: DeploymentRead }) {
	const surfaces = useStoreSurfaces();
	const model = useComputePlanModel(deployment);
	const { planSlug, subscription, fundingSource, billingTerm, recovery, lifecycle } = model;
	const rawPlanSlug = deployment.current_plan_slug;
	const paidPlan =
		planSlug === COMPUTE_BASIC_SLUG
			? resolveBasicPlan(model.plans.data)
			: planSlug === COMPUTE_PERFORMANCE_SLUG
				? resolvePerformancePlan(model.plans.data)
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
	const pendingPlanCopy = model.pendingPlanSlug
		? pendingPlanScheduleCopy(model.pendingPlanSlug, subscription?.current_period_end, periodLabel)
		: null;
	const actions = appComputeActions(
		!surfaces.cardBilling,
		// The normalized source: legacy null funding with a price is a card row.
		{ fundingSource },
		model.actions,
	);
	const managementReason = model.management.unavailableReason;
	const hasActions =
		Boolean(storeManagement) || model.recoveryTarget?.kind === "top_up" || actions.length > 0;
	return (
		<SettingsSection
			title={agentSettingsCopy.computePlan.title}
			description={agentSettingsCopy.computePlan.description}
		>
			<ComputeSubscriptionCard
				view={view}
				badges={
					model.terminalRecovery?.fundingSource === "wallet" ? (
						<Badge variant="outline">
							<Text className="font-normal text-muted-foreground">
								{agentSettingsCopy.computePlan.walletFallback}
							</Text>
						</Badge>
					) : null
				}
				notice={
					store || pendingPlanCopy || managementReason || model.createUnavailableMessage ? (
						<AppView className="gap-1">
							{store ? <StoreSubscriptionNotice management={storeManagement} /> : null}
							{pendingPlanCopy ? (
								<Text className="text-xs font-medium text-warning-muted-foreground">
									{pendingPlanCopy}
								</Text>
							) : null}
							{managementReason ? (
								<Text className="text-xs text-muted-foreground">{managementReason}</Text>
							) : null}
							{model.createUnavailableMessage ? (
								<Text className="text-xs text-muted-foreground">
									{model.createUnavailableMessage}
								</Text>
							) : null}
						</AppView>
					) : null
				}
				actions={
					hasActions ? (
						<>
							{storeManagement ? <StoreSubscriptionActions management={storeManagement} /> : null}
							{model.recoveryTarget?.kind === "top_up" ? <WalletTopUpAction size="sm" /> : null}
							<ComputeSubscriptionActions
								actions={actions}
								agentId={deployment.agent_id}
								startNewLabel={agentSettingsCopy.computePlan.chooseSubscription}
								commandTarget={{ deployment_id: deployment.resource.id }}
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
