import { describe, expect, test } from "bun:test";
import { BillingApiError } from "@/hosted/billing/errors";
import {
	walletPlanChangeFailure,
	walletPlanChangeSummary,
	walletPlanResultTarget,
	walletPlanTarget,
} from "./wallet-plan-change.logic";

describe("wallet plan change logic", () => {
	test("selects the opposite paid compute tier", () => {
		expect(walletPlanTarget("compute_basic")).toBe("compute_performance");
		expect(walletPlanTarget("compute_performance")).toBe("compute_basic");
	});

	test("rejects an unexpected target returned at the API boundary", () => {
		const quote = {
			subscription_id: 1,
			current_plan_slug: "compute_basic",
			target_plan_slug: "legacy_plan",
			status: "quoted",
			effective_at: "2026-08-01T00:00:00Z",
			amount_cents: 1_900,
			amount_credits: "19000",
			points_per_usd: 1000,
		};
		expect(walletPlanResultTarget(quote)).toBeNull();
	});

	test("describes both directions as next-renewal changes", () => {
		const base = {
			subscription_id: 1,
			current_plan_slug: "compute_basic",
			target_plan_slug: "compute_performance",
			status: "quoted",
			effective_at: "2026-08-01T00:00:00Z",
			amount_cents: 1_900,
			amount_credits: "19000",
			points_per_usd: 1000,
		};
		expect(walletPlanChangeSummary(base)).toBe(
			"Changes at next renewal on Aug 1, 2026 · then $19.00/mo.",
		);
	});

	test("extracts actionable refund debt from a plan-change conflict", () => {
		expect(
			walletPlanChangeFailure(
				new BillingApiError(409, "refund debt", {
					detail: { code: "open_refund_debt", outstanding_debt_credits: "2500.5" },
				}),
			),
		).toEqual({ kind: "refund_debt", debtCredits: 2500.5 });
	});

	test("keeps typed upstream failures retryable", () => {
		expect(
			walletPlanChangeFailure(
				new BillingApiError(502, "upstream", {
					detail: {
						code: "wallet_compute_charge_failed",
						failure_code: "deployment_resize_failed",
						retryable: true,
					},
				}),
			),
		).toEqual({ kind: "retryable", debtCredits: null });
	});
});
