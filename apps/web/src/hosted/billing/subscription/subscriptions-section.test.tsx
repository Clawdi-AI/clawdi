import { beforeAll, describe, expect, test } from "bun:test";
import type { ComputeSubscriptionListItem } from "@/hosted/billing/contracts";

type SubscriptionsSectionModule =
	typeof import("@/hosted/billing/subscription/subscriptions-section");

let sortLoadedSubscriptions: SubscriptionsSectionModule["sortLoadedSubscriptions"] | null = null;

beforeAll(async () => {
	process.env.VITE_CLAWDI_API_URL = "http://localhost:8000";
	process.env.VITE_CLAWDI_DEPLOY_API_URL = "http://localhost:50021";
	process.env.VITE_CLERK_PUBLISHABLE_KEY = "pk_test_dummy";
	const module = await import("@/hosted/billing/subscription/subscriptions-section");
	sortLoadedSubscriptions = module.sortLoadedSubscriptions;
});

function subscription(
	subscriptionId: string,
	status: ComputeSubscriptionListItem["status"],
): ComputeSubscriptionListItem {
	return {
		subscription_id: subscriptionId,
		plan_slug: "compute_basic",
		funding_source: "stripe",
		status,
		currency: "usd",
		billing_term_months: 1,
		cancel_at_period_end: status === "canceling",
		agent_name: subscriptionId,
		is_orphan: false,
	};
}

describe("SubscriptionsSection", () => {
	test("stably prioritizes loaded current subscriptions without mutating query data", () => {
		if (!sortLoadedSubscriptions) throw new Error("Subscriptions helpers were not loaded");
		const loaded = [
			subscription("canceled", "canceled"),
			subscription("canceling-first", "canceling"),
			subscription("active-first", "active"),
			subscription("past-due", "past_due"),
			subscription("active-second", "active"),
			subscription("canceling-second", "canceling"),
		];

		expect(sortLoadedSubscriptions(loaded).map((item) => item.subscription_id)).toEqual([
			"active-first",
			"active-second",
			"past-due",
			"canceling-first",
			"canceling-second",
			"canceled",
		]);
		expect(loaded.map((item) => item.subscription_id)).toEqual([
			"canceled",
			"canceling-first",
			"active-first",
			"past-due",
			"active-second",
			"canceling-second",
		]);
	});
});
