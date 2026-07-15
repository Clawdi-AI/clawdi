import { describe, expect, test } from "bun:test";
import type { ComputePlanSlug, HostedDeployment, Plan } from "@/hosted/billing/contracts";
import {
	resolveBasicDeploySelection,
	usesActiveIncludedBasicSlot,
} from "@/hosted/billing/deploy/deploy-model";

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

function deployment({
	status,
	computePlanSlug = "compute_basic",
	computeSubscription,
}: {
	status: string;
	computePlanSlug?: ComputePlanSlug;
	computeSubscription?: HostedDeployment["compute_subscription"];
}): HostedDeployment {
	return {
		id: `hdep_${status}_${computePlanSlug}`,
		user_id: "usr_test",
		name: "Test agent",
		app_id: "v2-test",
		status,
		created_at: "2026-06-24T00:00:00Z",
		upgrade_available: false,
		compute_subscription: computeSubscription,
		config_info: {
			compute_plan_slug: computePlanSlug,
			mux_enabled: false,
			telegram_mux_enabled: false,
			discord_mux_enabled: false,
			whatsapp_mux_enabled: false,
			imessage_mux_enabled: false,
			kobb_available: false,
			ai_provider_auth_kind: "managed",
			runtime: "openclaw",
			clawdi_cloud_environments: {},
			ai_provider_bindings: {},
			public_ports: [],
		},
	};
}

function plan(priceCents: number): Plan {
	return {
		slug: "compute_basic",
		name: "Basic",
		price_cents: priceCents,
		points_per_usd: 100,
		signup_grant_credits: 0,
		subscription_grant_credits: 0,
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
	test("counts active free-funded Basic deployments", () => {
		expect(usesActiveIncludedBasicSlot([deployment({ status: "running" })])).toBe(true);
		expect(usesActiveIncludedBasicSlot([deployment({ status: "starting" })])).toBe(true);
		expect(usesActiveIncludedBasicSlot([deployment({ status: "failed" })])).toBe(true);
		expect(usesActiveIncludedBasicSlot([deployment({ status: "deleting" })])).toBe(true);
	});

	test("ignores inactive, paid-funded Basic, and Performance deployments", () => {
		expect(usesActiveIncludedBasicSlot([deployment({ status: "stopped" })])).toBe(false);
		expect(usesActiveIncludedBasicSlot([deployment({ status: "deleted" })])).toBe(false);
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

	test("deploys compute_basic directly while included funding is available", () => {
		expect(
			resolveBasicDeploySelection({
				includedSlotUsed: false,
				basicPlan: basic,
				billingTermMonths: 1,
			}),
		).toEqual({ mode: "direct", computePlanSlug: "compute_basic", plan: basic });
	});

	test("starts compute_basic checkout with the API offer after included funding is used", () => {
		const selection = resolveBasicDeploySelection({
			includedSlotUsed: true,
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

	test("requires the canonical Basic plan for either funding path", () => {
		expect(
			resolveBasicDeploySelection({
				includedSlotUsed: false,
				basicPlan: undefined,
				billingTermMonths: 1,
			}),
		).toEqual({ mode: "unavailable", reason: "plan_missing" });
		expect(
			resolveBasicDeploySelection({
				includedSlotUsed: true,
				basicPlan: undefined,
				billingTermMonths: 1,
			}),
		).toEqual({ mode: "unavailable", reason: "plan_missing" });
	});

	test("requires a real API offer only when the included slot is occupied", () => {
		const basicWithoutOffers = { ...basic, offers: [] };

		expect(
			resolveBasicDeploySelection({
				includedSlotUsed: false,
				basicPlan: basicWithoutOffers,
				billingTermMonths: 1,
			}),
		).toEqual({
			mode: "direct",
			computePlanSlug: "compute_basic",
			plan: basicWithoutOffers,
		});
		expect(
			resolveBasicDeploySelection({
				includedSlotUsed: true,
				basicPlan: basicWithoutOffers,
				billingTermMonths: 1,
			}),
		).toEqual({ mode: "unavailable", reason: "offers_missing" });
	});
});

/**
 * The active-state half of the funding-slot contract. Every row must match the
 * deploy API occupancy predicate; subscription-backed Basic is excluded before
 * this predicate runs because it does not consume included funding.
 */
describe("usesActiveIncludedBasicSlot agrees with the backend occupancy predicate", () => {
	const cases: Array<{ status: string; failureReason: string | null; occupies: boolean }> = [
		{ status: "running", failureReason: null, occupies: true },
		{ status: "starting", failureReason: null, occupies: true },
		{ status: "creating", failureReason: null, occupies: true },
		{ status: "deleting", failureReason: null, occupies: true },
		{ status: "stopped", failureReason: null, occupies: false },
		{ status: "deleted", failureReason: null, occupies: false },
		{ status: "failed", failureReason: "backend_status=not_found", occupies: false },
		{
			status: "failed",
			failureReason: "backend_status=not_found; statefulset missing",
			occupies: false,
		},
		{ status: "failed", failureReason: "creation_interrupted", occupies: false },
		{ status: "failed", failureReason: "startup_probe_failing; restart_count=2", occupies: true },
		{ status: "failed", failureReason: null, occupies: true },
		{ status: "some_future_state", failureReason: null, occupies: true },
	];

	for (const { status, failureReason, occupies } of cases) {
		test(`${status} / ${failureReason ?? "no reason"} → ${occupies ? "occupies" : "available"}`, () => {
			const candidate = { ...deployment({ status }), failure_reason: failureReason };
			expect(usesActiveIncludedBasicSlot([candidate])).toBe(occupies);
		});
	}

	test("excludes subscription-backed Basic before applying occupancy", () => {
		const candidate = {
			...deployment({ status: "running", computeSubscription: subscription() }),
			failure_reason: null,
		};
		expect(usesActiveIncludedBasicSlot([candidate])).toBe(false);
	});
});
