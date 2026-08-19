import { describe, expect, test } from "bun:test";
import type { Plan } from "@/hosted/billing/contracts";
import { resolveBasicDeploySelection } from "@/hosted/billing/deploy/deploy-model";

function plan(priceCents: number): Plan {
	return {
		slug: "compute_basic",
		name: "Basic",
		price_cents: priceCents,
		signup_grant_usd: "0",
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
			includedSlotAvailable: false,
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
				includedSlotAvailable: false,
			}),
		).toEqual({ mode: "unavailable", reason: "plan_missing" });
	});

	test("requires a real API offer for the funding-driven create path", () => {
		const basicWithoutOffers = { ...basic, offers: [] };

		expect(
			resolveBasicDeploySelection({
				basicPlan: basicWithoutOffers,
				billingTermMonths: 1,
				includedSlotAvailable: false,
			}),
		).toEqual({ mode: "unavailable", reason: "offers_missing" });
	});

	test("never exposes paid Basic checkout before deployment inventory succeeds", () => {
		expect(
			resolveBasicDeploySelection({
				basicPlan: basic,
				billingTermMonths: 1,
				includedSlotAvailable: null,
			}),
		).toEqual({ mode: "unavailable", reason: "inventory_unavailable" });
	});
});
