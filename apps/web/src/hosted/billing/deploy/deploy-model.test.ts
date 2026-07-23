import { describe, expect, test } from "bun:test";
import type {
	ComputePlanSlug,
	HostedComputeSubscription,
	HostedDeploymentStatus,
	Plan,
} from "@/hosted/billing/contracts";
import {
	planCAccessAllowsDeploy,
	resolveBasicDeploySelection,
	usesActiveIncludedBasicSlot,
} from "@/hosted/billing/deploy/deploy-model";
import { hostedDeploymentFixture } from "@/hosted/hosted-deployment.test-fixture";

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

function deployment({
	status,
	computePlanSlug = "compute_basic",
	computeSubscription = includedSubscription(),
	occupiesSlot = true,
}: {
	status: HostedDeploymentStatus["summary_state"];
	computePlanSlug?: ComputePlanSlug;
	computeSubscription?: HostedComputeSubscription;
	occupiesSlot?: boolean;
}) {
	return hostedDeploymentFixture({
		id: `hdep_${status}_${computePlanSlug}`,
		name: "Test agent",
		status,
		createdAt: "2026-06-24T00:00:00Z",
		currentPlanSlug: computePlanSlug,
		computeSubscription,
		fundingFact: null,
		occupiesSlot,
	});
}

function plan(priceCents: number): Plan {
	return {
		slug: "compute_basic",
		name: "Basic",
		price_cents: priceCents,
		points_per_usd: 100,
		signup_grant_credits: 0,
		vcpu: 2,
		ram_gb: 4,
		disk_size: 20,
		offers: [
			{
				billing_term_months: 1,
				price_cents: priceCents,
				effective_monthly_price_cents: priceCents,
				discount_percent: 0,
			},
		],
	};
}

describe("usesActiveIncludedBasicSlot", () => {
	test("uses current_plan_slug and slot occupancy without a funding fact", () => {
		expect(usesActiveIncludedBasicSlot([deployment({ status: "running" })])).toBe(true);
		expect(
			usesActiveIncludedBasicSlot([deployment({ status: "running", occupiesSlot: false })]),
		).toBe(false);
	});

	test("ignores paid-funded Basic and Performance deployments", () => {
		expect(
			usesActiveIncludedBasicSlot([
				deployment({ status: "running", computeSubscription: subscription() }),
			]),
		).toBe(false);
		expect(
			usesActiveIncludedBasicSlot([
				deployment({ status: "running", computePlanSlug: "compute_performance" }),
			]),
		).toBe(false);
	});
});

describe("resolveBasicDeploySelection", () => {
	const basic = plan(900);

	test("uses the declarative included path while the Basic slot is available", () => {
		expect(
			resolveBasicDeploySelection({
				basicPlan: basic,
				billingTermMonths: 1,
				includedSlotAvailable: true,
			}),
		).toEqual({
			mode: "included",
			computePlanSlug: "compute_basic",
			plan: basic,
		});
	});

	test("starts compute_basic checkout with the wizard-selected API offer", () => {
		const selection = resolveBasicDeploySelection({
			basicPlan: basic,
			billingTermMonths: 1,
		});

		expect(selection).toMatchObject({
			mode: "checkout",
			computePlanSlug: "compute_basic",
			billingTermMonths: 1,
			plan: basic,
			offer: { price_cents: 900 },
		});
	});

	test("requires the canonical Basic plan", () => {
		expect(
			resolveBasicDeploySelection({
				basicPlan: undefined,
				billingTermMonths: 1,
			}),
		).toEqual({ mode: "unavailable", reason: "plan_missing" });
	});

	test("requires a real API offer for the funding-driven create path", () => {
		const basicWithoutOffers = { ...basic, offers: [] };

		expect(
			resolveBasicDeploySelection({
				basicPlan: basicWithoutOffers,
				billingTermMonths: 1,
			}),
		).toEqual({ mode: "unavailable", reason: "offers_missing" });
	});
});

describe("planCAccessAllowsDeploy", () => {
	test("allows an included Basic slot whether the Plan C switch is on or off", () => {
		const included = resolveBasicDeploySelection({
			basicPlan: plan(900),
			billingTermMonths: 1,
			includedSlotAvailable: true,
		});
		expect(planCAccessAllowsDeploy(true, included)).toBeTrue();
		expect(planCAccessAllowsDeploy(false, included)).toBeTrue();
	});

	test("keeps paid deployment behind the Plan C emergency switch", () => {
		expect(planCAccessAllowsDeploy(true, "paid")).toBeTrue();
		expect(planCAccessAllowsDeploy(false, "paid")).toBeFalse();
	});
});
