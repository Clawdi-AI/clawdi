import { describe, expect, test } from "bun:test";
import type { DeployRequest } from "@/hosted/billing/contracts";
import {
	buildPlanCSubscriptionCreateIntent,
	planCBillingTermMonths,
} from "@/hosted/billing/subscription/subscription-create";

const deployConfig: DeployRequest = {
	compute_plan_slug: "compute_performance",
	runtime: "openclaw",
	ai_provider_auth_kind: "unmanaged",
};

describe("Plan C subscription create intent", () => {
	test("accepts monthly and annual terms for both funding rails", () => {
		expect(planCBillingTermMonths(1)).toBe(1);
		expect(planCBillingTermMonths(12)).toBe(12);
		expect(
			buildPlanCSubscriptionCreateIntent({
				planSlug: "compute_performance",
				billingTermMonths: 12,
				fundingSource: "wallet",
				deployConfig,
			}),
		).toEqual({
			planSlug: "compute_performance",
			billingTermMonths: 12,
			fundingSource: "wallet",
			deployConfig,
		});
		expect(
			buildPlanCSubscriptionCreateIntent({
				planSlug: "compute_performance",
				billingTermMonths: 1,
				fundingSource: "stripe",
				deployConfig,
			})?.fundingSource,
		).toBe("stripe");
	});

	test("rejects a term outside the Plan C monthly and annual contract", () => {
		expect(planCBillingTermMonths(3)).toBeNull();
		expect(
			buildPlanCSubscriptionCreateIntent({
				planSlug: "compute_performance",
				billingTermMonths: 3,
				fundingSource: "wallet",
				deployConfig,
			}),
		).toBeNull();
	});
});
