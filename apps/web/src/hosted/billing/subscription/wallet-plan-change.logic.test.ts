import { describe, expect, test } from "bun:test";
import { BillingApiError } from "@/hosted/billing/errors";
import {
	walletPlanChangeFailure,
	walletPlanChangeSummary,
	walletPlanTarget,
} from "./wallet-plan-change.logic";

describe("wallet plan change logic", () => {
	test("selects the opposite paid compute tier", () => {
		expect(walletPlanTarget("compute_basic")).toBe("compute_performance");
		expect(walletPlanTarget("compute_performance")).toBe("compute_basic");
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
				detail: { shortfall_credits: "2500.5" },
			}),
		);
		expect(failure).toEqual({ kind: "insufficient", shortfallCredits: 2500.5 });
	});
});
