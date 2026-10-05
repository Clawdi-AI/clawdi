import {
	computeSubscriptionRecoveryPresentation,
	type DeployComponents,
	type DeploymentRead,
} from "../api";
import { formatShortDate } from "./format";

type HostedComputeSubscription = NonNullable<
	NonNullable<DeploymentRead["commercial_display"]>["compute_subscription"]
>;
type ComputePlanSlug = DeployComponents["schemas"]["V2HostedDeployRequest"]["compute_plan_slug"];
export const COMPUTE_BASIC_SLUG = "compute_basic" as const;
export const COMPUTE_PERFORMANCE_SLUG = "compute_performance" as const;
const COMPUTE_RENEWING_STATUSES = new Set(["trialing", "active", "past_due"]);
export function isBasicCompute(planSlug: string | null | undefined): boolean {
	return planSlug === COMPUTE_BASIC_SLUG;
}

export type ComputeFundingMode = "included_basic" | "subscription" | "unknown";

export type ComputeFundingSource = "included_basic" | "stripe" | "wallet" | "unknown";

type ComputeFundingSubscription = Pick<HostedComputeSubscription, "funding_source" | "price_cents">;

export function isIncludedBasicSubscription(
	planSlug: string | null | undefined,
	computeSubscription: ComputeFundingSubscription | null | undefined,
): boolean {
	return (
		isBasicCompute(planSlug) &&
		computeSubscription != null &&
		computeSubscription.funding_source == null &&
		computeSubscription.price_cents === 0
	);
}

export function computeFundingMode(
	planSlug: string | null | undefined,
	computeSubscription: ComputeFundingSubscription | null | undefined,
): ComputeFundingMode {
	const source = computeFundingSource(planSlug, computeSubscription);
	if (source === "included_basic") return "included_basic";
	return source === "stripe" || source === "wallet" ? "subscription" : "unknown";
}

export function computeFundingSource(
	planSlug: string | null | undefined,
	computeSubscription: ComputeFundingSubscription | null | undefined,
): ComputeFundingSource {
	if (isIncludedBasicSubscription(planSlug, computeSubscription)) return "included_basic";
	if (computeSubscription?.funding_source === "stripe") return "stripe";
	if (computeSubscription?.funding_source === "wallet") return "wallet";
	// Pre-wallet deployment projections can omit Card funding. A positive paid price
	// disambiguates that legacy shape from Included Basic and malformed null funding.
	if (computeSubscription?.funding_source == null && (computeSubscription?.price_cents ?? 0) > 0) {
		return "stripe";
	}
	return "unknown";
}

export type ComputeSubscriptionLifecycle = {
	badgeLabel: string;
	badgeTone: "success" | "warning" | "destructive" | "neutral";
	dateAt: string | null;
	dateVerb: string | null;
	renews: boolean;
};

type ComputeSubscriptionLifecycleInput = {
	lifecycle_status?: string | null;
	status: string;
	cancel_at_period_end: boolean;
	current_period_end?: string | null;
	cancel_at?: string | null;
	canceled_at?: string | null;
	pending_plan_slug?: string | null;
};

export function computeSubscriptionLifecycle(
	subscription: ComputeSubscriptionLifecycleInput,
): ComputeSubscriptionLifecycle {
	const status = (subscription.lifecycle_status ?? subscription.status).toLowerCase();
	const canceledAt = subscription.canceled_at ?? subscription.current_period_end ?? null;
	if (
		status === "canceling" ||
		(subscription.cancel_at_period_end && COMPUTE_RENEWING_STATUSES.has(status))
	) {
		return {
			badgeLabel: "Canceling",
			badgeTone: "warning",
			dateAt: subscription.cancel_at ?? subscription.current_period_end ?? null,
			dateVerb: "Ends",
			renews: false,
		};
	}
	if (status === "active") {
		return {
			badgeLabel: "Active",
			badgeTone: subscription.pending_plan_slug ? "warning" : "success",
			dateAt: subscription.current_period_end ?? null,
			dateVerb: "Renews",
			renews: true,
		};
	}
	if (status === "trialing") {
		return {
			badgeLabel: "Trial",
			badgeTone: subscription.pending_plan_slug ? "warning" : "success",
			dateAt: subscription.current_period_end ?? null,
			dateVerb: "Renews",
			renews: true,
		};
	}
	if (status === "past_due") {
		return {
			badgeLabel: "Past due",
			badgeTone: "destructive",
			dateAt: null,
			dateVerb: null,
			renews: true,
		};
	}
	if (status === "unpaid") {
		return {
			badgeLabel: "Unpaid",
			badgeTone: "destructive",
			dateAt: null,
			dateVerb: null,
			renews: false,
		};
	}
	if (status === "paused") {
		return {
			badgeLabel: "Paused",
			badgeTone: "neutral",
			dateAt: null,
			dateVerb: null,
			renews: false,
		};
	}
	if (status === "incomplete") {
		return {
			badgeLabel: "Setup incomplete",
			badgeTone: "warning",
			dateAt: null,
			dateVerb: null,
			renews: false,
		};
	}
	if (status === "canceled") {
		return {
			badgeLabel: "Ended",
			badgeTone: "neutral",
			dateAt: null,
			dateVerb: null,
			renews: false,
		};
	}
	if (status === "expired" || status === "incomplete_expired") {
		return {
			badgeLabel: "Expired",
			badgeTone: "neutral",
			dateAt: canceledAt,
			dateVerb: "Expired",
			renews: false,
		};
	}
	return {
		badgeLabel: "Status unavailable",
		badgeTone: "neutral",
		dateAt: null,
		dateVerb: null,
		renews: false,
	};
}

export function computeTierLabel(
	planSlug: ComputePlanSlug | null | undefined,
): "Basic" | "Performance" {
	return planSlug === COMPUTE_PERFORMANCE_SLUG ? "Performance" : "Basic";
}

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
