import { describe, expect, test } from "bun:test";
import type { BillingOffer, Plan } from "@/hosted/billing/contracts";
import {
	COMPUTE_FREE_SLUG,
	COMPUTE_PERFORMANCE_SLUG,
	isComputeSubscriptionCancelable,
	isComputeSubscriptionTermChangeable,
	resolveFreePlan,
	resolvePerformancePlan,
	selectOfferForTerm,
} from "@/hosted/billing/subscription/subscription-utils";

function offer(term: number, priceCents: number): BillingOffer {
	return {
		billing_term_months: term,
		price_cents: priceCents,
		effective_monthly_price_cents: Math.round(priceCents / term),
		discount_percent: 0,
	};
}

function plan(overrides: Partial<Plan> & Pick<Plan, "slug" | "price_cents">): Plan {
	const { slug, price_cents: priceCents, ...rest } = overrides;
	return {
		slug,
		name: slug,
		price_cents: priceCents,
		points_per_usd: 100,
		signup_grant_credits: 0,
		subscription_grant_credits: 0,
		vcpu: 1,
		ram_gb: 1,
		disk_size: 10,
		...rest,
	};
}

describe("compute plan resolvers", () => {
	test("resolvePerformancePlan prefers the canonical slug before price fallback", () => {
		const priceFallback = plan({ slug: "legacy_paid", price_cents: 1900 });
		const canonical = plan({ slug: COMPUTE_PERFORMANCE_SLUG, price_cents: 0 });

		expect(resolvePerformancePlan([priceFallback, canonical])).toBe(canonical);
	});

	test("resolvePerformancePlan falls back to the first paid plan when the slug is absent", () => {
		const free = plan({ slug: COMPUTE_FREE_SLUG, price_cents: 0 });
		const paid = plan({ slug: "paid", price_cents: 1900 });

		expect(resolvePerformancePlan([free, paid])).toBe(paid);
	});

	test("resolveFreePlan prefers the canonical slug before price fallback", () => {
		const priceFallback = plan({ slug: "legacy_free", price_cents: 0 });
		const canonical = plan({ slug: COMPUTE_FREE_SLUG, price_cents: 500 });

		expect(resolveFreePlan([priceFallback, canonical])).toBe(canonical);
	});
});

describe("selectOfferForTerm", () => {
	test("returns the requested offer and canonical term for a valid term", () => {
		const annual = offer(12, 19_000);
		const selected = selectOfferForTerm(
			plan({
				slug: COMPUTE_PERFORMANCE_SLUG,
				price_cents: 1900,
				offers: [offer(1, 1900), annual],
			}),
			12,
		);

		expect(selected.offer).toBe(annual);
		expect(selected.billingTermMonths).toBe(12);
	});

	test("falls back to the first offer and returns its canonical term for a missing term", () => {
		const monthly = offer(1, 1900);
		const selected = selectOfferForTerm(
			plan({
				slug: COMPUTE_PERFORMANCE_SLUG,
				price_cents: 1900,
				offers: [monthly, offer(12, 19_000)],
			}),
			3,
		);

		expect(selected.offer).toBe(monthly);
		expect(selected.billingTermMonths).toBe(1);
	});

	test("uses a synthetic monthly offer when the plan has empty offers", () => {
		const selected = selectOfferForTerm(
			plan({
				slug: COMPUTE_PERFORMANCE_SLUG,
				price_cents: 1900,
				offers: [],
			}),
			12,
		);

		expect(selected).toEqual({
			offer: {
				billing_term_months: 1,
				price_cents: 1900,
				effective_monthly_price_cents: 1900,
				discount_percent: 0,
			},
			billingTermMonths: 1,
		});
	});
});

describe("compute subscription action status gates", () => {
	test("matches the backend cancel and resume status set", () => {
		expect(isComputeSubscriptionCancelable({ status: "trialing" })).toBe(true);
		expect(isComputeSubscriptionCancelable({ status: "active" })).toBe(true);
		expect(isComputeSubscriptionCancelable({ status: "past_due" })).toBe(true);

		expect(isComputeSubscriptionCancelable({ status: "incomplete" })).toBe(false);
		expect(isComputeSubscriptionCancelable({ status: "unpaid" })).toBe(false);
		expect(isComputeSubscriptionCancelable({ status: "canceled" })).toBe(false);
		expect(isComputeSubscriptionCancelable(null)).toBe(false);
	});

	test("keeps term changes stricter than cancel or resume", () => {
		expect(isComputeSubscriptionTermChangeable({ status: "trialing" })).toBe(true);
		expect(isComputeSubscriptionTermChangeable({ status: "active" })).toBe(true);

		expect(isComputeSubscriptionTermChangeable({ status: "past_due" })).toBe(false);
		expect(isComputeSubscriptionTermChangeable({ status: "unpaid" })).toBe(false);
		expect(isComputeSubscriptionTermChangeable(undefined)).toBe(false);
	});
});
