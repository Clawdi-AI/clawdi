import type { BillingOffer, Plan } from "@/hosted/billing/contracts";

/** Format an ISO date as a short, local calendar date. */
export function shortDate(iso: string | null): string {
	if (!iso) return "—";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "—";
	return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
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

export function selectOfferForTerm(plan: Plan, term: number): BillingOffer {
	const offers = planOffers(plan);
	return offers.find((o) => o.billing_term_months === term) ?? offers[0];
}
