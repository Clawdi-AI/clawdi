import { beforeAll, describe, expect, test } from "bun:test";
import type { ComputeSubscriptionListItem } from "@/hosted/billing/contracts";

type SubscriptionsSectionModule =
	typeof import("@/hosted/billing/subscription/subscriptions-section");

let sortLoadedSubscriptions: SubscriptionsSectionModule["sortLoadedSubscriptions"] | null = null;
let canManageAccountSubscription:
	| SubscriptionsSectionModule["canManageAccountSubscription"]
	| null = null;

beforeAll(async () => {
	process.env.VITE_CLAWDI_API_URL = "http://localhost:8000";
	process.env.VITE_CLAWDI_DEPLOY_API_URL = "http://localhost:50021";
	process.env.VITE_CLERK_PUBLISHABLE_KEY = "pk_test_dummy";
	const module = await import("@/hosted/billing/subscription/subscriptions-section");
	sortLoadedSubscriptions = module.sortLoadedSubscriptions;
	canManageAccountSubscription = module.canManageAccountSubscription;
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
		deployment_id: `hdep_${subscriptionId}`,
		agent_name: subscriptionId,
		is_orphan: false,
		payment_state: "ok",
		latest_failed_invoice_hosted_url: null,
		next_payment_attempt_at: null,
		recovery_action: null,
		pending_plan_slug: null,
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

	test("only exposes management for current paid subscriptions", () => {
		if (!canManageAccountSubscription) throw new Error("Subscriptions helpers were not loaded");
		const active = subscription("active", "active");

		expect(canManageAccountSubscription(active)).toBe(true);
		expect(canManageAccountSubscription(subscription("past-due", "past_due"))).toBe(false);
		expect(canManageAccountSubscription(subscription("canceling", "canceling"))).toBe(false);
		expect(canManageAccountSubscription(subscription("canceled", "canceled"))).toBe(false);
		expect(canManageAccountSubscription({ ...active, recovery_action: "fix_payment" })).toBe(false);
		expect(
			canManageAccountSubscription({ ...active, pending_plan_slug: "compute_performance" }),
		).toBe(false);
		expect(canManageAccountSubscription({ ...active, is_orphan: true })).toBe(false);
		expect(canManageAccountSubscription({ ...active, deployment_id: null })).toBe(false);
		expect(canManageAccountSubscription({ ...active, cancel_at_period_end: true })).toBe(false);
	});
});
