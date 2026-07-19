import { describe, expect, test } from "bun:test";
import type { BillingOffer, HostedComputeSubscription, Plan } from "@/hosted/billing/contracts";
import {
	COMPUTE_BASIC_SLUG,
	COMPUTE_PERFORMANCE_SLUG,
	computeFundingMode,
	computeFundingSource,
	computeSubscriptionId,
	computeSubscriptionLifecycle,
	computeTierLabel,
	isBasicCompute,
	isComputeSubscriptionCancelable,
	isComputeSubscriptionRenewing,
	isComputeSubscriptionTermChangeable,
	isIncludedBasicSubscription,
	pendingComputePlanSlug,
	pendingPlanScheduleCopy,
	resolveBasicPlan,
	resolvePerformancePlan,
	resolveSubscriptionCreatePlanSlug,
	selectExplicitOfferForTerm,
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
		vcpu: 1,
		ram_gb: 1,
		disk_size: 10,
		...rest,
	};
}

function subscription(): HostedComputeSubscription {
	return {
		status: "active",
		funding_source: "stripe",
		payment_state: "ok",
		billing_term_months: 1,
		price_cents: 900,
		currency: "usd",
		cancel_at_period_end: false,
	};
}

function includedSubscription(): HostedComputeSubscription {
	return {
		subscription_id: 7,
		status: "active",
		funding_source: null,
		payment_state: "ok",
		billing_term_months: 1,
		price_cents: 0,
		currency: "usd",
		cancel_at_period_end: false,
	};
}

describe("compute plan resolvers", () => {
	test("resolvePerformancePlan selects only the canonical slug", () => {
		const otherPaid = plan({ slug: "legacy_paid", price_cents: 1900 });
		const canonical = plan({ slug: COMPUTE_PERFORMANCE_SLUG, price_cents: 0 });

		expect(resolvePerformancePlan([otherPaid, canonical])).toBe(canonical);
	});

	test("resolvePerformancePlan does not infer Performance from a positive price", () => {
		const basic = plan({ slug: COMPUTE_BASIC_SLUG, price_cents: 900 });
		const paid = plan({ slug: "paid", price_cents: 1900 });

		expect(resolvePerformancePlan([basic, paid])).toBeUndefined();
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

describe("resolveSubscriptionCreatePlanSlug", () => {
	test("defaults resubscribe to the authoritative prior plan", () => {
		expect(
			resolveSubscriptionCreatePlanSlug(COMPUTE_BASIC_SLUG, {
				basicAvailable: true,
				performanceAvailable: true,
			}),
		).toBe(COMPUTE_BASIC_SLUG);
		expect(
			resolveSubscriptionCreatePlanSlug(COMPUTE_PERFORMANCE_SLUG, {
				basicAvailable: true,
				performanceAvailable: true,
			}),
		).toBe(COMPUTE_PERFORMANCE_SLUG);
	});

	test("uses the other saleable plan only when the prior plan is unavailable", () => {
		expect(
			resolveSubscriptionCreatePlanSlug(COMPUTE_BASIC_SLUG, {
				basicAvailable: false,
				performanceAvailable: true,
			}),
		).toBe(COMPUTE_PERFORMANCE_SLUG);
		expect(
			resolveSubscriptionCreatePlanSlug(COMPUTE_PERFORMANCE_SLUG, {
				basicAvailable: true,
				performanceAvailable: false,
			}),
		).toBe(COMPUTE_BASIC_SLUG);
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
	test("derives included and paid Basic from the generated funding projection", () => {
		expect(computeFundingMode(COMPUTE_BASIC_SLUG, includedSubscription())).toBe("included_basic");
		expect(computeFundingMode(COMPUTE_BASIC_SLUG, subscription())).toBe("subscription");
		expect(isIncludedBasicSubscription(COMPUTE_BASIC_SLUG, includedSubscription())).toBe(true);
	});

	test("does not resurrect the deleted null subscription projection", () => {
		expect(computeFundingMode(COMPUTE_BASIC_SLUG, null)).toBe("unknown");
		expect(computeFundingSource(COMPUTE_BASIC_SLUG, null)).toBe("unknown");
		expect(isIncludedBasicSubscription(COMPUTE_BASIC_SLUG, null)).toBe(false);
	});

	test("does not infer included funding for Performance without subscription state", () => {
		expect(computeFundingMode(COMPUTE_PERFORMANCE_SLUG, subscription())).toBe("subscription");
		expect(computeFundingMode(COMPUTE_PERFORMANCE_SLUG, null)).toBe("unknown");
	});

	test("distinguishes Stripe and Wallet subscription funding", () => {
		expect(computeFundingSource(COMPUTE_BASIC_SLUG, includedSubscription())).toBe("included_basic");
		expect(computeFundingSource(COMPUTE_BASIC_SLUG, subscription())).toBe("stripe");
		expect(
			computeFundingSource(COMPUTE_BASIC_SLUG, { ...subscription(), funding_source: "wallet" }),
		).toBe("wallet");
	});

	test("reads additive wallet subscription metadata only when valid", () => {
		const withMetadata = {
			...subscription(),
			subscription_id: 42,
			pending_plan_slug: COMPUTE_BASIC_SLUG,
		};
		expect(computeSubscriptionId(withMetadata)).toBe(42);
		expect(pendingComputePlanSlug(withMetadata)).toBe(COMPUTE_BASIC_SLUG);
		expect(computeSubscriptionId(subscription())).toBeNull();
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

describe("selectExplicitOfferForTerm", () => {
	test("selects only offers advertised by the plans API", () => {
		const annual = offer(12, 8_640);
		const selected = selectExplicitOfferForTerm(
			plan({
				slug: COMPUTE_BASIC_SLUG,
				price_cents: 900,
				offers: [offer(1, 900), annual],
			}),
			12,
		);

		expect(selected).toEqual({ offer: annual, billingTermMonths: 12 });
	});

	test("returns null instead of synthesizing a purchasable offer", () => {
		expect(
			selectExplicitOfferForTerm(
				plan({ slug: COMPUTE_BASIC_SLUG, price_cents: 900, offers: [] }),
				1,
			),
		).toBeNull();
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
		expect(isComputeSubscriptionTermChangeable({ status: "active" })).toBe(true);

		expect(isComputeSubscriptionTermChangeable({ status: "trialing" })).toBe(false);
		expect(isComputeSubscriptionTermChangeable({ status: "past_due" })).toBe(false);
		expect(isComputeSubscriptionTermChangeable({ status: "unpaid" })).toBe(false);
		expect(isComputeSubscriptionTermChangeable(undefined)).toBe(false);
	});
});

describe("compute subscription lifecycle presentation", () => {
	test("only renewing states present as renewing", () => {
		for (const status of ["active", "trialing", "past_due"]) {
			expect(isComputeSubscriptionRenewing({ ...subscription(), status }), status).toBe(true);
		}
		for (const status of ["unpaid", "paused", "incomplete", "canceled", "expired"]) {
			expect(isComputeSubscriptionRenewing({ ...subscription(), status }), status).toBe(false);
		}
		expect(isComputeSubscriptionRenewing({ ...subscription(), cancel_at_period_end: true })).toBe(
			false,
		);
	});

	test("labels terminal and non-entitled states honestly", () => {
		expect(computeSubscriptionLifecycle({ ...subscription(), status: "paused" })).toMatchObject({
			badgeLabel: "Paused",
			renews: false,
		});
		expect(
			computeSubscriptionLifecycle({
				...subscription(),
				status: "past_due",
			}),
		).toMatchObject({
			badgeLabel: "Payment past due",
			dateAt: null,
			dateVerb: null,
			renews: true,
		});
		expect(computeSubscriptionLifecycle({ ...subscription(), status: "incomplete" })).toMatchObject(
			{ badgeLabel: "Setup incomplete", renews: false },
		);
		expect(computeSubscriptionLifecycle({ ...subscription(), status: "canceled" })).toMatchObject({
			badgeLabel: "Canceled",
			dateVerb: "Canceled",
			renews: false,
		});
		expect(computeSubscriptionLifecycle({ ...subscription(), status: "expired" })).toMatchObject({
			badgeLabel: "Expired",
			renews: false,
		});
	});

	test("describes the server-projected schedule without local renewal state", () => {
		expect(pendingPlanScheduleCopy("compute_basic", "2026-07-01T00:00:00Z", "Jul 1, 2026")).toBe(
			"Basic scheduled for Jul 1, 2026.",
		);
		expect(pendingPlanScheduleCopy("compute_basic", "2026-08-01T00:00:00Z", "Aug 1, 2026")).toBe(
			"Basic scheduled for Aug 1, 2026.",
		);
	});
});
