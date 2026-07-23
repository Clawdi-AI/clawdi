import { describe, expect, test } from "bun:test";
import { hostedDeploymentFixture } from "@/hosted/hosted-deployment.test-fixture";
import {
	deleteDeploymentWithSubscriptionChoice,
	offersSubscriptionDeleteChoice,
} from "./deployment-delete-action.logic";

function paidDeployment() {
	const deployment = hostedDeploymentFixture({ id: "hdep_paid_delete" });
	return {
		...deployment,
		current_plan_slug: "compute_basic",
		commercial_display: {
			...deployment.commercial_display,
			compute_subscription: {
				subscription_id: 42,
				status: "active",
				funding_source: "stripe" as const,
				payment_state: "ok" as const,
				billing_term_months: 12,
				price_cents: 8_640,
				currency: "usd",
				cancel_at_period_end: false,
				current_period_end: "2027-07-15T00:00:00Z",
			},
		},
	};
}

describe("hosted deployment deletion", () => {
	test("offers the keep-or-cancel choice only for a renewing paid subscription", () => {
		const paid = paidDeployment();
		expect(offersSubscriptionDeleteChoice(paid)).toBe(true);
		expect(
			offersSubscriptionDeleteChoice({
				...paid,
				commercial_display: {
					...paid.commercial_display,
					compute_subscription: {
						...paid.commercial_display.compute_subscription,
						cancel_at_period_end: true,
					},
				},
			}),
		).toBe(false);
	});

	test("keeps the subscription by default and only deletes the deployment", async () => {
		const calls: string[] = [];
		await deleteDeploymentWithSubscriptionChoice({
			choice: "keep_subscription",
			cancelSubscription: async () => {
				calls.push("cancel");
			},
			deleteDeployment: async () => {
				calls.push("delete");
			},
		});
		expect(calls).toEqual(["delete"]);
	});

	test("records cancellation before deleting", async () => {
		const calls: string[] = [];
		await deleteDeploymentWithSubscriptionChoice({
			choice: "cancel_subscription",
			cancelSubscription: async () => {
				calls.push("cancel");
			},
			deleteDeployment: async () => {
				calls.push("delete");
			},
		});
		expect(calls).toEqual(["cancel", "delete"]);
	});

	test("does not delete when cancellation intent cannot be recorded", async () => {
		const calls: string[] = [];
		expect(
			deleteDeploymentWithSubscriptionChoice({
				choice: "cancel_subscription",
				cancelSubscription: async () => {
					calls.push("cancel");
					throw new Error("cancel unavailable");
				},
				deleteDeployment: async () => {
					calls.push("delete");
				},
			}),
		).rejects.toThrow("cancel unavailable");
		expect(calls).toEqual(["cancel"]);
	});

	test("keeps the recorded cancellation when deployment deletion fails", async () => {
		const calls: string[] = [];
		expect(
			deleteDeploymentWithSubscriptionChoice({
				choice: "cancel_subscription",
				cancelSubscription: async () => {
					calls.push("cancel");
				},
				deleteDeployment: async () => {
					calls.push("delete");
					throw new Error("delete unavailable");
				},
			}),
		).rejects.toThrow("delete unavailable");
		expect(calls).toEqual(["cancel", "delete"]);
	});
});
