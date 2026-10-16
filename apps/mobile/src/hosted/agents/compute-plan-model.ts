import { computeSubscriptionRecoveryPresentation, type DeploymentRead } from "@clawdi/shared/api";
import {
	COMPUTE_BASIC_SLUG,
	COMPUTE_PERFORMANCE_SLUG,
	type ComputeSubscriptionManagementResult,
	computeDunningState,
	computeFundingSource,
	computeSubscriptionLifecycle,
	computeSubscriptionManagement,
	detachedStoreRecoveryTarget,
	pendingComputePlanSlug,
	planChangeBillingTerm,
	resolveBasicPlan,
	resolveComputeSubscriptionActions,
	resolvePerformancePlan,
	resolveSubscriptionCreatePlanSlug,
} from "@clawdi/shared/view";
import { useQuery } from "@tanstack/react-query";
import { useDashboardDeployments, useProductCapabilities } from "@/hooks/use-dashboard-agents";
import { usePlans } from "@/hosted/billing/hooks";
import { useMobileApi } from "@/lib/api-provider";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";

/** Reads an Agent's deployment through the detail screen's cache entry. */
export function useAgentDeployment(agentId: string | undefined) {
	const { hosted } = useMobileApi();
	const scope = useAccountScope();
	const read = useAccountRead();
	const inventory = useDashboardDeployments();
	const deploymentId = inventory.data?.find((item) => item.agent_id === agentId)?.resource.id;
	const query = useQuery({
		queryKey: accountQueryKey(scope, "deployment", deploymentId ?? "missing"),
		queryFn: ({ signal }) =>
			read((s) => {
				if (!hosted || !deploymentId) throw new Error("Deployment unavailable");
				return hosted.getDeployment(deploymentId, s);
			}, signal),
		enabled: scope.isReady && Boolean(hosted && deploymentId),
		retry: false,
	});
	return {
		deployment: query.data,
		isPending: inventory.isPending || (Boolean(deploymentId) && query.isPending),
		error: inventory.error ?? query.error,
		missing: inventory.data !== undefined && !deploymentId,
		retry: () => void (deploymentId ? query.refetch() : inventory.refetch()),
	};
}

/**
 * Web's agent Settings compute model (hosted-agent-detail.tsx): the card's recovery,
 * plan management, "Choose a subscription" availability and the resolved actions. The
 * Compute plan section and both subscription sheets read the same values.
 */
export function useComputePlanModel(deployment: DeploymentRead | undefined) {
	const plans = usePlans();
	const capabilities = useProductCapabilities();
	const canCreateCloudAgents = capabilities.data?.can_use_v2 === true;
	const rawPlanSlug = deployment?.current_plan_slug;
	const planSlug: typeof COMPUTE_BASIC_SLUG | typeof COMPUTE_PERFORMANCE_SLUG | undefined =
		rawPlanSlug === COMPUTE_BASIC_SLUG || rawPlanSlug === COMPUTE_PERFORMANCE_SLUG
			? rawPlanSlug
			: undefined;
	const subscription = deployment?.commercial_display?.compute_subscription;
	const fundingSource = computeFundingSource(planSlug, subscription);
	const dunning = deployment ? computeDunningState(deployment) : null;
	const terminalRecovery = dunning?.recoveryTarget?.kind === "start_new" ? dunning : null;
	const pendingPlanSlug = pendingComputePlanSlug(subscription);
	const billingTerm = planChangeBillingTerm(subscription?.billing_term_months ?? 1);
	const basicPlan = resolveBasicPlan(plans.data);
	const performancePlan = resolvePerformancePlan(plans.data);
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
		(deployment ? detachedStoreRecoveryTarget(deployment) : null);
	const canOfferStartNew = recoveryTarget?.kind === "start_new";
	const management: ComputeSubscriptionManagementResult =
		deployment && subscription
			? computeSubscriptionManagement({
					entitlement: {
						deploymentId: deployment.resource.id,
						planSlug,
						fundingSource: subscription.funding_source,
						priceCents: subscription.price_cents,
						billingTermMonths: subscription.billing_term_months,
						status: subscription.status,
						paymentState: subscription.payment_state,
						cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
						recoveryAction: subscription.recovery_action,
						pendingPlanSlug,
					},
					deployment,
					canCreateCloudAgents,
					plansLoading: plans.isPending,
					performancePlanAvailable: Boolean(performancePlan),
				})
			: { action: "hidden", target: null, unavailableReason: null };
	const hasPendingChange =
		management.action === "enabled" && management.target.projectedOperationName !== null;
	// Web's copy while "Choose a subscription" can't open yet.
	const createUnavailableMessage = !canOfferStartNew
		? null
		: plans.isPending || capabilities.isPending
			? "Checking paid compute availability…"
			: !canCreateCloudAgents
				? "New subscriptions are temporarily unavailable."
				: !(basicPlan || performancePlan)
					? "Paid compute plans are unavailable right now."
					: null;
	const actions = deployment
		? resolveComputeSubscriptionActions({
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
				management,
				recoveryTarget,
				hasPendingOperation: hasPendingChange,
				startNewUnavailableReason: createUnavailableMessage,
			})
		: [];
	return {
		plans,
		canCreateCloudAgents,
		rawPlanSlug,
		planSlug,
		subscription,
		fundingSource,
		terminalRecovery,
		pendingPlanSlug,
		billingTerm,
		lifecycle,
		recovery,
		recoveryTarget,
		canOfferStartNew,
		management,
		hasPendingChange,
		createUnavailableMessage,
		subscriptionCreatePlanSlug: resolveSubscriptionCreatePlanSlug(
			terminalRecovery?.recoveryPlanSlug ?? pendingPlanSlug ?? planSlug,
			{ basicAvailable: Boolean(basicPlan), performanceAvailable: Boolean(performancePlan) },
		),
		actions,
	};
}
