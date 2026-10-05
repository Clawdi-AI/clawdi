import { computeSubscriptionRecoveryPresentation, type DeploymentRead } from "../api";
import {
	COMPUTE_BASIC_SLUG,
	COMPUTE_PERFORMANCE_SLUG,
	computeFundingSource,
	computeSubscriptionLifecycle,
	computeTierLabel,
} from "./compute-subscriptions";
import { formatMemoryMib, formatShortDate } from "./format";

type HostedComputeSubscription = NonNullable<
	NonNullable<DeploymentRead["commercial_display"]>["compute_subscription"]
>;
export type OverviewComputeDate = { label: string; value: string };

function displayDate(
	label: string,
	value: string | null | undefined,
	now: number,
	historical = false,
): OverviewComputeDate | null {
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
): OverviewComputeDate | null {
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

export function activePlanChangeOperationName(
	deployment: Pick<DeploymentRead, "accepted_operation" | "resource">,
): string | null {
	const operation = deployment.accepted_operation;
	if (
		operation?.done !== false ||
		operation.metadata.verb !== "plan_change" ||
		operation.metadata.deploymentId !== deployment.resource.id
	)
		return null;
	return operation.name.trim() || null;
}
export function overviewComputeState(deployment: DeploymentRead, now = Date.now()) {
	const planSlug = deployment.current_plan_slug;
	const planLabel =
		planSlug === COMPUTE_BASIC_SLUG || planSlug === COMPUTE_PERFORMANCE_SLUG
			? `${computeTierLabel(planSlug)} plan`
			: "Plan unavailable";
	const subscription = deployment.commercial_display?.compute_subscription;
	if (!subscription)
		return {
			facts: { planLabel, subscription: null, date: null },
			subscription: null,
			operation: null,
			pending: false,
			funding: null,
			recovery: null,
		};
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

	return { facts, subscription, operation, pending, funding, recovery };
}

/** The same ordered resource facts on the Web and native Compute summary. */
export function overviewComputeSpecs(resources?: {
	vcpu: number;
	memory_mib: number;
	disk_gib: number;
}) {
	return [
		{ key: "cpu", label: "CPU", value: resources ? `${resources.vcpu} vCPU` : null },
		{
			key: "memory",
			label: "Memory",
			value: resources ? `${formatMemoryMib(resources.memory_mib)} RAM` : null,
		},
		{
			key: "storage",
			label: "Storage",
			value: resources ? `${resources.disk_gib} GiB storage` : null,
		},
	] as const;
}
export const overviewComputeSummaryCopy = {
	resources: "Compute resources",
	subscription: "Subscription",
	nextRenewal: "Next renewal",
	planAccess: "Plan access",
} as const;
