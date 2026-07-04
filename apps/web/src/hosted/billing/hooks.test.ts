import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import type { ComputeSubscriptionActionResult, HostedDeployment } from "@/hosted/billing/contracts";
import { applyDeploymentSubscriptionResult, billingKeys } from "@/hosted/billing/hooks";

function deployment(
	computeSubscription: NonNullable<HostedDeployment["compute_subscription"]>,
): HostedDeployment {
	return {
		id: "dep_123",
		user_id: "user_123",
		name: "Performance agent",
		app_id: "app_123",
		backend: null,
		status: "running",
		endpoints: [],
		openclaw_control_ui_url: null,
		hermes_control_ui_url: null,
		compute_subscription: computeSubscription,
		created_at: "2026-06-22T00:00:00Z",
		upgrade_available: false,
	};
}

function subscriptionAction(cancelAtPeriodEnd: boolean): ComputeSubscriptionActionResult {
	return {
		status: "active",
		billing_term_months: 12,
		cancel_at_period_end: cancelAtPeriodEnd,
		current_period_end: "2026-08-01T00:00:00Z",
		cancel_at: cancelAtPeriodEnd ? "2026-08-01T00:00:00Z" : null,
	};
}

describe("applyDeploymentSubscriptionResult", () => {
	test("patches cancel and resume state without immediately invalidating deployments", () => {
		const qc = new QueryClient();
		qc.setQueryData<HostedDeployment[]>(billingKeys.deployments, [
			deployment({
				status: "active",
				billing_term_months: 1,
				price_cents: 2_000,
				currency: "usd",
				cancel_at_period_end: false,
				current_period_end: "2026-07-01T00:00:00Z",
				cancel_at: null,
			}),
		]);

		applyDeploymentSubscriptionResult(qc, "dep_123", subscriptionAction(true));

		let patched = qc.getQueryData<HostedDeployment[]>(billingKeys.deployments);
		expect(patched?.[0]?.compute_subscription?.cancel_at_period_end).toBe(true);
		expect(patched?.[0]?.compute_subscription?.billing_term_months).toBe(12);
		expect(qc.getQueryState(billingKeys.deployments)?.isInvalidated).toBe(false);

		applyDeploymentSubscriptionResult(qc, "dep_123", subscriptionAction(false));

		patched = qc.getQueryData<HostedDeployment[]>(billingKeys.deployments);
		expect(patched?.[0]?.compute_subscription?.cancel_at_period_end).toBe(false);
		expect(patched?.[0]?.compute_subscription?.cancel_at).toBeNull();
		expect(qc.getQueryState(billingKeys.deployments)?.isInvalidated).toBe(false);
	});
});
