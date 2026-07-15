import { describe, expect, test } from "bun:test";
import type { BillingOffer, HostedDeployment, Plan } from "@/hosted/billing/contracts";
import {
	COMPUTE_BASIC_SLUG,
	COMPUTE_PERFORMANCE_SLUG,
	computeFundingMode,
	computeTierLabel,
	isBasicCompute,
	isComputeSubscriptionCancelable,
	isComputeSubscriptionTermChangeable,
	resolveBasicPlan,
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

function subscription(): NonNullable<HostedDeployment["compute_subscription"]> {
	return {
		status: "active",
		payment_state: "ok",
		billing_term_months: 1,
		price_cents: 900,
		currency: "usd",
		cancel_at_period_end: false,
	};
}

describe("compute plan resolvers", () => {
	test("resolvePerformancePlan prefers the canonical slug before price fallback", () => {
		const priceFallback = plan({ slug: "legacy_paid", price_cents: 1900 });
		const canonical = plan({ slug: COMPUTE_PERFORMANCE_SLUG, price_cents: 0 });

		expect(resolvePerformancePlan([priceFallback, canonical])).toBe(canonical);
	});

	test("resolvePerformancePlan falls back to the first paid plan when the slug is absent", () => {
		const basic = plan({ slug: COMPUTE_BASIC_SLUG, price_cents: 900 });
		const paid = plan({ slug: "paid", price_cents: 1900 });

		expect(resolvePerformancePlan([basic, paid])).toBe(paid);
	});

	test("resolvePerformancePlan never treats compute_basic as the positive-price fallback", () => {
		const basic = plan({ slug: COMPUTE_BASIC_SLUG, price_cents: 900 });

		expect(resolvePerformancePlan([basic])).toBeUndefined();
	});

	test("resolveBasicPlan only resolves the canonical Basic plan", () => {
		const otherPaid = plan({ slug: "legacy_paid", price_cents: 900 });
		const basic = plan({ slug: COMPUTE_BASIC_SLUG, price_cents: 1_100 });

		expect(resolveBasicPlan([otherPaid, basic])).toBe(basic);
		expect(resolveBasicPlan([otherPaid])).toBeUndefined();
	});
});

describe("compute tier naming", () => {
	test("presents the low tier as Basic", () => {
		expect(computeTierLabel(COMPUTE_BASIC_SLUG)).toBe("Basic");
		expect(computeTierLabel(COMPUTE_PERFORMANCE_SLUG)).toBe("Performance");
	});

	test("recognizes the Basic slug without inferring its funding source", () => {
		expect(isBasicCompute(COMPUTE_BASIC_SLUG)).toBe(true);
		expect(isBasicCompute(COMPUTE_PERFORMANCE_SLUG)).toBe(false);
	});
});

describe("compute funding", () => {
	test("derives included and paid Basic from subscription presence", () => {
		expect(computeFundingMode(COMPUTE_BASIC_SLUG, null)).toBe("included_basic");
		expect(computeFundingMode(COMPUTE_BASIC_SLUG, subscription())).toBe("subscription");
	});

	test("does not infer included funding for Performance without subscription state", () => {
		expect(computeFundingMode(COMPUTE_PERFORMANCE_SLUG, subscription())).toBe("subscription");
		expect(computeFundingMode(COMPUTE_PERFORMANCE_SLUG, null)).toBe("unknown");
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
