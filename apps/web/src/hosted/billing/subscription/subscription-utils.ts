import type { BillingOffer, Plan } from "@/hosted/billing/contracts";

export const COMPUTE_FREE_SLUG = "compute_free";
export const COMPUTE_PERFORMANCE_SLUG = "compute_performance";
export const COMPUTE_SUBSCRIPTION_CANCELABLE_STATUSES = new Set(["trialing", "active", "past_due"]);
export const COMPUTE_SUBSCRIPTION_TERM_CHANGEABLE_STATUSES = new Set(["trialing", "active"]);

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

export function resolveFreePlan(plans: Plan[] | undefined): Plan | undefined {
	return (
		plans?.find((plan) => plan.slug === COMPUTE_FREE_SLUG) ??
		plans?.find((plan) => plan.price_cents === 0)
	);
}

export function resolvePerformancePlan(plans: Plan[] | undefined): Plan | undefined {
	return (
		plans?.find((plan) => plan.slug === COMPUTE_PERFORMANCE_SLUG) ??
		plans?.find((plan) => plan.price_cents > 0)
	);
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

export function selectOfferForTerm(plan: Plan, term: number): ResolvedBillingOffer {
	const offers = planOffers(plan);
	const offer = offers.find((o) => o.billing_term_months === term) ?? offers[0];
	return { offer, billingTermMonths: offer.billing_term_months };
}
