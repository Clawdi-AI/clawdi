import { describe, expect, test } from "bun:test";
import type { DeploymentRead } from "@clawdi/shared/api";
import {
	deploymentDeleteCopy,
	deploymentDeleteSubscriptionPolicy,
} from "./compute-subscription-actions";

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
	test("releases Included Basic and keeps non-renewing paid subscriptions", () => {
		expect(
			deploymentDeleteSubscriptionPolicy({
				current_plan_slug: "compute_basic",
				commercial_display: {
					compute_subscription: { ...card, funding_source: null, price_cents: 0 },
				},
			}),
		).toEqual({
			offerChoice: false,
			defaultChoice: "cancel_subscription",
			storeNotice: null,
		});
		expect(policy({ ...card, cancel_at_period_end: true })).toEqual({
			offerChoice: false,
			defaultChoice: "keep_subscription",
			storeNotice: null,
		});
	});
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
						contract_id: "11111111-1111-4111-8111-111111111111",
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

describe("Agent delete copy", () => {
	const base = {
		name: "Research bot",
		choice: "cancel_subscription",
		offerChoice: true,
		storeNotice: null,
		cancelAtPeriodEnd: false,
		isTrial: false,
		periodEndLabel: "Nov 7, 2026",
	} as const;

	test("offers keep and cancel with the matching confirm label", () => {
		const cancel = deploymentDeleteCopy(base);
		expect(cancel.title).toBe("Delete Research bot?");
		expect(cancel.notice).toBeNull();
		expect(cancel.choices.map((option) => option.value)).toEqual([
			"keep_subscription",
			"cancel_subscription",
		]);
		expect(cancel.choices[0]?.description).toBe(
			"Keep subscription — it becomes available to choose for a future agent. Valid through Nov 7, 2026.",
		);
		expect(cancel.choices[1]?.description).toContain("remain active through Nov 7, 2026");
		expect(cancel.confirmLabel).toBe("Delete agent and cancel subscription");
		expect(deploymentDeleteCopy({ ...base, choice: "keep_subscription" }).confirmLabel).toBe(
			"Delete agent (keep subscription)",
		);
	});

	test("a trial ends immediately and an unknown period end is left out", () => {
		const copy = deploymentDeleteCopy({ ...base, isTrial: true, periodEndLabel: null });
		expect(copy.choices[0]?.description).toBe(
			"Keep subscription — it becomes available to choose for a future agent.",
		);
		expect(copy.choices[1]?.description).toBe(
			"The trial ends immediately. This cannot restore a deleted agent.",
		);
	});

	test("without a choice it shows the store or scheduled-cancellation notice", () => {
		const store = deploymentDeleteCopy({
			...base,
			offerChoice: false,
			storeNotice: "Deleting this agent doesn't cancel your App Store subscription.",
			cancelAtPeriodEnd: true,
		});
		expect(store.choices).toEqual([]);
		expect(store.notice).toBe("Deleting this agent doesn't cancel your App Store subscription.");
		expect(store.confirmLabel).toBe("Delete agent");
		expect(
			deploymentDeleteCopy({ ...base, offerChoice: false, cancelAtPeriodEnd: true }).notice,
		).toContain("already scheduled to stop at period end");
		expect(deploymentDeleteCopy({ ...base, offerChoice: false }).notice).toBeNull();
	});
});
