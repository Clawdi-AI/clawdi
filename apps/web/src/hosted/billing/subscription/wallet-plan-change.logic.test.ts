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
			change_kind: "upgrade" as const,
			status: "quoted",
			effective_at: "2026-07-15T00:00:00Z",
			period_start: "2026-07-01T00:00:00Z",
			period_end: "2026-08-01T00:00:00Z",
			prorated_delta_cents: 700,
			prorated_delta_credits: "7000",
			points_per_usd: 1000,
		};
		expect(walletPlanResultTarget(quote)).toBeNull();
	});

	test("describes immediate upgrades and scheduled downgrades", () => {
		const base = {
			subscription_id: 1,
			current_plan_slug: "compute_basic",
			target_plan_slug: "compute_performance",
			status: "quoted",
			effective_at: "2026-07-15T00:00:00Z",
			period_start: "2026-07-01T00:00:00Z",
			period_end: "2026-08-01T00:00:00Z",
			prorated_delta_cents: 700,
			prorated_delta_credits: "7000",
			points_per_usd: 1000,
		};
		expect(walletPlanChangeSummary({ ...base, change_kind: "upgrade" })).toContain(
			"resizes immediately",
		);
		expect(walletPlanChangeSummary({ ...base, change_kind: "downgrade" })).toContain(
			"next renewal",
		);
	});

	test("classifies a plan-change shortfall", () => {
		const failure = walletPlanChangeFailure(
			new BillingApiError(402, "insufficient", {
				detail: {
					code: "insufficient_wallet_balance",
					required_credits: "7000.0",
					available_credits: "4499.5",
					shortfall_credits: "2500.5",
				},
			}),
		);
		expect(failure).toEqual({ kind: "insufficient", shortfallCredits: 2500.5 });
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
		).toEqual({ kind: "retryable", shortfallCredits: null });
	});
});
