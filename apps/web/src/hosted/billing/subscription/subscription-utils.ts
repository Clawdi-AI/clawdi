import {
	type BillingOffer,
	COMPUTE_BASIC_SLUG,
	COMPUTE_PERFORMANCE_SLUG,
	type ComputePlanSlug,
	type HostedDeployment,
	type Plan,
} from "@/hosted/billing/contracts";

export { COMPUTE_BASIC_SLUG, COMPUTE_PERFORMANCE_SLUG };
export const COMPUTE_SUBSCRIPTION_CANCELABLE_STATUSES = new Set(["trialing", "active", "past_due"]);
export const COMPUTE_SUBSCRIPTION_TERM_CHANGEABLE_STATUSES = new Set(["active"]);

export type ResolvedBillingOffer = {
	offer: BillingOffer;
	billingTermMonths: number;
};

type ComputeSubscriptionStatusInput =
	| {
			status?: string | null;
	  }
	| null
	| undefined;

export function isComputeSubscriptionCancelable(
	subscription: ComputeSubscriptionStatusInput,
): boolean {
	return COMPUTE_SUBSCRIPTION_CANCELABLE_STATUSES.has(subscription?.status ?? "");
}

export function isComputeSubscriptionTermChangeable(
	subscription: ComputeSubscriptionStatusInput,
): boolean {
	return COMPUTE_SUBSCRIPTION_TERM_CHANGEABLE_STATUSES.has(subscription?.status ?? "");
}

export function resolveBasicPlan(plans: Plan[] | undefined): Plan | undefined {
	return plans?.find((plan) => plan.slug === COMPUTE_BASIC_SLUG);
}

export function resolvePerformancePlan(plans: Plan[] | undefined): Plan | undefined {
	return plans?.find((plan) => plan.slug === COMPUTE_PERFORMANCE_SLUG);
}

export function isBasicCompute(planSlug: string | null | undefined): boolean {
	return planSlug === COMPUTE_BASIC_SLUG;
}

export type ComputeFundingMode = "included_basic" | "subscription" | "unknown";

export type ComputeFundingSource = "included_basic" | "stripe" | "wallet" | "unknown";

export function isIncludedBasicSubscription(
	planSlug: string | null | undefined,
	computeSubscription: HostedDeployment["compute_subscription"] | null | undefined,
): boolean {
	return (
		isBasicCompute(planSlug) &&
		(!computeSubscription ||
			(computeSubscription.funding_source == null && computeSubscription.price_cents === 0))
	);
}

export function computeFundingMode(
	planSlug: string | null | undefined,
	computeSubscription: HostedDeployment["compute_subscription"] | null | undefined,
): ComputeFundingMode {
	if (isIncludedBasicSubscription(planSlug, computeSubscription)) return "included_basic";
	if (computeSubscription) return "subscription";
	return "unknown";
}

export function computeFundingSource(
	planSlug: string | null | undefined,
	computeSubscription: HostedDeployment["compute_subscription"] | null | undefined,
): ComputeFundingSource {
	if (isIncludedBasicSubscription(planSlug, computeSubscription)) return "included_basic";
	if (computeSubscription?.funding_source === "wallet") return "wallet";
	// Additive rollout compatibility: subscriptions from the pre-wallet
	// deployment projection had no funding_source and were necessarily Stripe.
	if (computeSubscription) return "stripe";
	return "unknown";
}

export function computeSubscriptionId(
	subscription: HostedDeployment["compute_subscription"] | null | undefined,
): number | null {
	if (!subscription) return null;
	return typeof subscription.subscription_id === "number" &&
		Number.isInteger(subscription.subscription_id) &&
		subscription.subscription_id > 0
		? subscription.subscription_id
		: null;
}

export function pendingComputePlanSlug(
	subscription: HostedDeployment["compute_subscription"] | null | undefined,
): ComputePlanSlug | null {
	if (!subscription) return null;
	return subscription.pending_plan_slug === COMPUTE_BASIC_SLUG ||
		subscription.pending_plan_slug === COMPUTE_PERFORMANCE_SLUG
		? subscription.pending_plan_slug
		: null;
}

const COMPUTE_RENEWING_STATUSES = new Set(["trialing", "active", "past_due"]);

export function isComputeSubscriptionRenewing(
	subscription: HostedDeployment["compute_subscription"] | null | undefined,
): boolean {
	if (!subscription || subscription.cancel_at_period_end) return false;
	return (
		COMPUTE_RENEWING_STATUSES.has(subscription.status.toLowerCase()) &&
		subscription.payment_state !== "unpaid"
	);
}

export type ComputeSubscriptionLifecycle = {
	badgeLabel: string;
	dateAt: string | null;
	dateVerb: string | null;
	renews: boolean;
};

export function computeSubscriptionLifecycle(
	subscription: NonNullable<HostedDeployment["compute_subscription"]>,
): ComputeSubscriptionLifecycle {
	const status = subscription.status.toLowerCase();
	const canceledAt = subscription.canceled_at ?? subscription.current_period_end ?? null;
	if (subscription.cancel_at_period_end && COMPUTE_RENEWING_STATUSES.has(status)) {
		return {
			badgeLabel: "Canceling",
			dateAt: subscription.cancel_at ?? subscription.current_period_end ?? null,
			dateVerb: "Ends",
			renews: false,
		};
	}
	if (status === "active") {
		return {
			badgeLabel: "Current",
			dateAt: subscription.current_period_end ?? null,
			dateVerb: "Renews",
			renews: true,
		};
	}
	if (status === "trialing") {
		return {
			badgeLabel: "Trial",
			dateAt: subscription.current_period_end ?? null,
			dateVerb: "Renews",
			renews: true,
		};
	}
	if (status === "past_due") {
		return {
			badgeLabel: "Payment past due",
			dateAt: null,
			dateVerb: null,
			renews: true,
		};
	}
	if (status === "unpaid") {
		return { badgeLabel: "Unpaid", dateAt: canceledAt, dateVerb: "Ended", renews: false };
	}
	if (status === "paused") {
		return { badgeLabel: "Paused", dateAt: null, dateVerb: null, renews: false };
	}
	if (status === "incomplete") {
		return { badgeLabel: "Setup incomplete", dateAt: null, dateVerb: null, renews: false };
	}
	if (status === "canceled") {
		return { badgeLabel: "Canceled", dateAt: canceledAt, dateVerb: "Canceled", renews: false };
	}
	if (status === "expired" || status === "incomplete_expired") {
		return { badgeLabel: "Expired", dateAt: canceledAt, dateVerb: "Expired", renews: false };
	}
	return {
		badgeLabel: status.replace(/_/g, " ").replace(/\b\w/g, (character) => character.toUpperCase()),
		dateAt: null,
		dateVerb: null,
		renews: false,
	};
}

export function pendingPlanScheduleCopy(
	planSlug: ComputePlanSlug,
	effectiveAt: string | null | undefined,
	dateLabel: string,
): string {
	const planLabel = computeTierLabel(planSlug);
	return effectiveAt
		? `${planLabel} scheduled for ${dateLabel}.`
		: `${planLabel} scheduled for the next billing date.`;
}

export function computeTierLabel(
	planSlug: ComputePlanSlug | null | undefined,
): "Basic" | "Performance" {
	return planSlug === COMPUTE_PERFORMANCE_SLUG ? "Performance" : "Basic";
}

/**
 * The plan's offer for a billing term, with a synthetic monthly offer when the
 * backend returns no offers — so callers always have a price to show.
 */
export function planOffers(plan: Plan): BillingOffer[] {
	return plan.offers?.length
		? plan.offers
		: [
				{
					billing_term_months: 1,
					price_cents: plan.price_cents,
					effective_monthly_price_cents: plan.price_cents,
					discount_percent: 0,
				},
			];
}

/** Offers explicitly advertised by the plans API; an empty list is not purchasable. */
export function explicitPlanOffers(plan: Plan): BillingOffer[] {
	return plan.offers ?? [];
}

export function selectExplicitOfferForTerm(plan: Plan, term: number): ResolvedBillingOffer | null {
	const offers = explicitPlanOffers(plan);
	const offer = offers.find((candidate) => candidate.billing_term_months === term) ?? offers[0];
	return offer ? { offer, billingTermMonths: offer.billing_term_months } : null;
}

export function selectOfferForTerm(plan: Plan, term: number): ResolvedBillingOffer {
	const offers = planOffers(plan);
	const offer = offers.find((o) => o.billing_term_months === term) ?? offers[0];
	return { offer, billingTermMonths: offer.billing_term_months };
}
