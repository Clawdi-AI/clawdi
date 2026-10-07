import { beforeAll, describe, expect, test } from "bun:test";
import type { HostedComputeSubscription } from "@/hosted/billing/contracts";
import { hostedDeploymentFixture } from "@/hosted/hosted-deployment.test-fixture";

type DeletePolicy =
	typeof import("@/hosted/agents/deployment-delete-action").deploymentDeleteSubscriptionPolicy;

let deploymentDeleteSubscriptionPolicy: DeletePolicy | null = null;

beforeAll(async () => {
	process.env.VITE_CLAWDI_API_URL = "http://localhost:8000";
	process.env.VITE_CLAWDI_DEPLOY_API_URL = "http://localhost:50021";
	process.env.VITE_CLERK_PUBLISHABLE_KEY = "pk_test_dummy";
	({ deploymentDeleteSubscriptionPolicy } = await import(
		"@/hosted/agents/deployment-delete-action"
	));
});

const cardSubscription: HostedComputeSubscription = {
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

function policy(computeSubscription: HostedComputeSubscription) {
	if (!deploymentDeleteSubscriptionPolicy) throw new Error("Delete action was not loaded");
	return deploymentDeleteSubscriptionPolicy(
		hostedDeploymentFixture({ computeSubscription, currentPlanSlug: "compute_performance" }),
	);
}

describe("Agent delete subscription policy", () => {
	test("keeps card subscriptions' cancel choice", () => {
		expect(policy(cardSubscription)).toMatchObject({ offerChoice: true, storeNotice: null });
	});

	test("never offers cancellation for store-funded Agents and keeps the store subscription", () => {
		for (const [provider, store] of [
			["app_store", "App Store"],
			["play_store", "Google Play"],
		] as const) {
			expect(
				policy({
					...cardSubscription,
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
