import { describe, expect, test } from "bun:test";
import type { DeploymentRead } from "@clawdi/shared/api";
import { deploymentDeleteSubscriptionPolicy } from "./delete-subscription-policy";

type HostedComputeSubscription = NonNullable<
	NonNullable<DeploymentRead["commercial_display"]>["compute_subscription"]
>;

const card: HostedComputeSubscription = {
	status: "active",
	funding_source: "stripe",
	payment_state: "ok",
	billing_term_months: 1,
	price_cents: 2_000,
	currency: "usd",
	cancel_at_period_end: false,
	current_period_end: "2026-11-07T00:00:00Z",
	actions: { cancel: "cancel_at_period_end", resume: false, command_state: null },
};

function policy(compute_subscription: HostedComputeSubscription) {
	return deploymentDeleteSubscriptionPolicy({
		current_plan_slug: "compute_performance",
		commercial_display: { compute_subscription },
	});
}

describe("Agent delete subscription policy", () => {
	test("keeps the cancel choice for a renewing card subscription", () => {
		expect(policy(card)).toEqual({
			offerChoice: true,
			defaultChoice: "keep_subscription",
			storeNotice: null,
		});
	});

	test("store-funded Agents hide cancel choices and keep the store subscription", () => {
		for (const [provider, store] of [
			["app_store", "App Store"],
			["play_store", "Google Play"],
		] as const) {
			expect(
				policy({
					...card,
					funding_source: "store",
					price_cents: null,
					actions: { cancel: null, resume: false, command_state: null },
					store_management: {
						provider,
						product_id: "ai.clawdi.app.compute.performance.monthly",
						management_url: null,
						auto_renews: true,
						renews_or_ends_at: "2026-11-07T00:00:00Z",
						state: "active",
					},
				}),
			).toEqual({
				offerChoice: false,
				defaultChoice: "keep_subscription",
				storeNotice: `Deleting this agent doesn't cancel your ${store} subscription. Manage it on your device.`,
			});
		}
	});
});
