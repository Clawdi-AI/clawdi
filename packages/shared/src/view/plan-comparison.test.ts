import { expect, test } from "bun:test";
import type { DeployComponents } from "../api";
import { computePlanComparisonView } from "./plan-comparison";

type Plan = DeployComponents["schemas"]["V2PlanResponse"];
function plan(slug: string, term: number, price: number): Plan {
	return {
		slug,
		name: slug,
		price_cents: price,
		signup_grant_usd: "0",
		vcpu: 1,
		ram_gb: 2,
		disk_size: 10,
		offers: [
			{
				billing_term_months: term,
				price_cents: price,
				effective_monthly_price_cents: price / term,
				discount_percent: 0,
			},
		],
	};
}
test("comparison does not show unrelated-term prices when plans have no common offer", () => {
	const view = computePlanComparisonView(
		[plan("compute_basic", 1, 900), plan("compute_performance", 12, 19000)],
		1,
	);
	expect(view.sharedPricingUnavailable).toBe(true);
	expect(view.basicPrice).toBeNull();
	expect(view.performancePrice).toBeNull();
});
test("a stale selected term falls back to an explicit common offer for both plans", () => {
	const view = computePlanComparisonView(
		[plan("compute_basic", 1, 900), plan("compute_performance", 1, 1900)],
		12,
	);
	expect(view.selectedTerm).toBe(1);
	expect(view.basicPrice?.primary).toBe("$9.00/mo");
	expect(view.performancePrice?.primary).toBe("$19.00/mo");
});
