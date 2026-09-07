import { computeDunningState } from "@/hosted/billing/components/compute-dunning.logic";
import type { HostedComputeSubscription, HostedDeployment } from "@/hosted/billing/contracts";
import { resolveComputeSubscriptionActions } from "@/hosted/billing/subscription/compute-subscription-actions";
import { computeSubscriptionManagement } from "@/hosted/billing/subscription/compute-subscription-management";
import { computeSubscriptionRecoveryPresentation } from "@/hosted/billing/subscription/compute-subscription-recovery";
import { activePlanChangeOperationName } from "@/hosted/billing/subscription/plan-change.logic";
import {
	COMPUTE_BASIC_SLUG,
	COMPUTE_PERFORMANCE_SLUG,
	computeFundingSource,
	computeSubscriptionLifecycle,
	computeTierLabel,
	pendingComputePlanSlug,
} from "@/hosted/billing/subscription/subscription-utils";
import { deploymentFailurePresentation } from "@/hosted/deployment-failure";
import {
	deploymentStatusFromResource,
	hasCurrentRuntimeHealthDegradation,
} from "@/hosted/deployment-status";
import { formatShortDate } from "@/lib/format";

type Availability = Pick<
	Parameters<typeof computeSubscriptionManagement>[0],
	"canCreateCloudAgents" | "plansLoading" | "performancePlanAvailable"
>;

type OverviewAction = {
	kind: "upgrade" | "fix_payment" | "top_up" | "start_new";
	label: string;
};

type OverviewDate = { label: string; value: string };

function displayDate(
	label: string,
	value: string | null | undefined,
	now: number,
	historical = false,
): OverviewDate | null {
	if (!value) return null;
	const timestamp = Date.parse(value);
	if (!Number.isFinite(timestamp) || (historical ? timestamp > now : timestamp <= now)) return null;
	return { label, value: formatShortDate(value) };
}

function subscriptionDate(
	subscription: HostedComputeSubscription,
	funding: ReturnType<typeof computeFundingSource>,
	recovery: ReturnType<typeof computeSubscriptionRecoveryPresentation>,
	now: number,
): OverviewDate | null {
	const status = subscription.status.toLowerCase();
	if (status === "canceled") return displayDate("Ended on", subscription.canceled_at, now, true);
	if (status === "expired" || status === "incomplete_expired") {
		return displayDate("Expired on", computeSubscriptionLifecycle(subscription).dateAt, now, true);
	}
	if (recovery.hasPaymentIssue) {
		return recovery.schedule?.verb === "Retries"
			? displayDate("Next payment attempt", subscription.next_payment_attempt_at, now)
			: null;
	}
	if (
		(subscription.cancel_at_period_end && ["active", "trialing", "past_due"].includes(status)) ||
		status === "canceling"
	) {
		return displayDate("Ends on", subscription.cancel_at ?? subscription.current_period_end, now);
	}
	if (status === "trialing") return displayDate("Trial ends", subscription.current_period_end, now);
	return status === "active" && (funding === "stripe" || funding === "wallet")
		? displayDate("Next renewal", subscription.current_period_end, now)
		: null;
}

/** Overview facts and navigation-only actions share the billing projection and resolver. */
export function overviewComputePresentation(
	deployment: HostedDeployment,
	availability: Availability,
	now = Date.now(),
): {
	planLabel: string;
	subscription: { label: string | null; value: string } | null;
	date: OverviewDate | null;
	action: OverviewAction | null;
} {
	const planSlug = deployment.current_plan_slug;
	const planLabel =
		planSlug === COMPUTE_BASIC_SLUG || planSlug === COMPUTE_PERFORMANCE_SLUG
			? `${computeTierLabel(planSlug)} plan`
			: "Plan unavailable";
	const subscription = deployment.commercial_display?.compute_subscription;
	if (!subscription) return { planLabel, subscription: null, date: null, action: null };
	const funding = computeFundingSource(planSlug, subscription);
	const included = funding === "included_basic";
	const lifecycle = computeSubscriptionLifecycle(subscription);
	const recovery = computeSubscriptionRecoveryPresentation(subscription, {
		label: lifecycle.badgeLabel,
		tone: lifecycle.badgeTone,
	});
	const operation = activePlanChangeOperationName(deployment);
	const pending =
		operation !== null ||
		subscription.actions?.command_state != null ||
		subscription.recovery_blocked_reason != null;
	const includedActive =
		included &&
		subscription.status === "active" &&
		!subscription.cancel_at_period_end &&
		!pending &&
		!recovery.hasPaymentIssue;
	const facts = {
		planLabel,
		subscription: {
			label: includedActive ? null : "Subscription",
			value: includedActive
				? "Included with your plan"
				: operation
					? "Updating subscription"
					: recovery.status.label,
		},
		date: pending ? null : subscriptionDate(subscription, funding, recovery, now),
	};
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
