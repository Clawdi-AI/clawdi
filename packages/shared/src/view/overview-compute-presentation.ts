import type { DeploymentRead as HostedDeployment } from "../api";
import { computeDunningState } from "./compute-dunning";
import { resolveComputeSubscriptionActions } from "./compute-subscription-actions";
import { computeSubscriptionManagement } from "./compute-subscription-management";
import { pendingComputePlanSlug } from "./compute-subscriptions";
import { deploymentFailurePresentation } from "./deployment-failure";
import {
	deploymentStatusFromResource,
	hasCurrentRuntimeHealthDegradation,
} from "./deployment-status";
import { overviewComputeState } from "./overview-compute";

type Availability = Pick<
	Parameters<typeof computeSubscriptionManagement>[0],
	"canCreateCloudAgents" | "plansLoading" | "performancePlanAvailable"
>;

type OverviewAction = {
	kind: "upgrade" | "fix_payment" | "top_up" | "start_new";
	label: string;
};

/** Overview facts and navigation-only actions share the billing projection and resolver. */
export function overviewComputePresentation(
	deployment: HostedDeployment,
	availability: Availability,
	now = Date.now(),
): {
	planLabel: string;
	subscription: { label: string | null; value: string } | null;
	date: import("./overview-compute").OverviewComputeDate | null;
	action: OverviewAction | null;
} {
	const { facts, subscription, pending, recovery } = overviewComputeState(deployment, now);
	const planSlug = deployment.current_plan_slug;
	if (!subscription || !recovery) return { ...facts, action: null };
	const status = deploymentStatusFromResource(deployment.resource.status);
	if (!status.known || status.kind === "deleted" || status.kind === "deleting" || pending) {
		return { ...facts, action: null };
	}
	const entitlement = {
		deploymentId: deployment.resource.id,
		planSlug,
		fundingSource: subscription.funding_source,
		priceCents: subscription.price_cents,
		billingTermMonths: subscription.billing_term_months,
		status: subscription.status,
		paymentState: subscription.payment_state,
		cancelAtPeriodEnd: subscription.cancel_at_period_end,
		recoveryAction: subscription.recovery_action,
		pendingPlanSlug: pendingComputePlanSlug(subscription),
		actions: subscription.actions,
	};
	const stableRuntime =
		(status.kind === "running" || status.kind === "stopped") &&
		!deploymentFailurePresentation(deployment) &&
		!(deployment.resource.status && hasCurrentRuntimeHealthDegradation(deployment.resource.status));
	const management = stableRuntime
		? computeSubscriptionManagement({ entitlement, deployment, ...availability })
		: ({ action: "hidden", target: null, unavailableReason: null } as const);
	const actions = resolveComputeSubscriptionActions({
		entitlement,
		management,
		recoveryTarget: computeDunningState(deployment)?.recoveryTarget ?? recovery.recoveryTarget,
		startNewUnavailableReason: availability.canCreateCloudAgents
			? null
			: "Subscription changes unavailable",
	});
	for (const action of actions) {
		if (action.disabledReason !== null) continue;
		switch (action.kind) {
			case "upgrade":
				return { ...facts, action: { kind: action.kind, label: "Upgrade" } };
			case "fix_payment":
				return { ...facts, action: { kind: action.kind, label: "Fix payment" } };
			case "top_up":
				return { ...facts, action: { kind: action.kind, label: "Top up" } };
			case "start_new":
				return { ...facts, action: { kind: action.kind, label: "Manage" } };
		}
	}
	return { ...facts, action: null };
}
