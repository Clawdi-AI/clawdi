import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import type { ComputeSubscriptionActionResult, HostedDeployment } from "@/hosted/billing/contracts";
import {
	applyDeploymentSubscriptionResult,
	billingKeys,
	checkoutReturnMarker,
	checkoutReturnWasCanceled,
	refreshCheckoutReturnQueries,
} from "@/hosted/billing/hooks";

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

describe("refreshCheckoutReturnQueries", () => {
	test("forces deployments and wallet refetches even when cached data is fresh", async () => {
		const qc = new QueryClient({
			defaultOptions: {
				queries: {
					retry: false,
					staleTime: 30_000,
				},
			},
		});
		const beforeCheckout = deployment({
			status: "active",
			billing_term_months: 1,
			price_cents: 2_000,
			currency: "usd",
			cancel_at_period_end: false,
			current_period_end: "2026-07-01T00:00:00Z",
			cancel_at: null,
		});
		const afterCheckout: HostedDeployment = {
			...beforeCheckout,
			name: "Performance agent after checkout",
			compute_subscription: {
				status: "active",
				billing_term_months: 12,
				price_cents: 20_000,
				currency: "usd",
				cancel_at_period_end: false,
				current_period_end: "2027-07-01T00:00:00Z",
				cancel_at: null,
			},
		};
		const deploymentSnapshots: HostedDeployment[][] = [[beforeCheckout], [afterCheckout]];
		const walletSnapshots = [{ balance_cents: 1_000 }, { balance_cents: 5_000 }];
		let deploymentsCalls = 0;
		let walletCalls = 0;

		await qc.prefetchQuery({
			queryKey: billingKeys.deployments,
			queryFn: async () => {
				deploymentsCalls += 1;
				return deploymentSnapshots.shift() ?? [afterCheckout];
			},
		});
		await qc.prefetchQuery({
			queryKey: billingKeys.wallet,
			queryFn: async () => {
				walletCalls += 1;
				return walletSnapshots.shift() ?? { balance_cents: 5_000 };
			},
		});
		qc.setQueryData(billingKeys.plans, [{ id: "plan_before_checkout" }]);
		qc.setQueryData(["agents"], [{ id: "agent_before_checkout" }]);

		const result = await refreshCheckoutReturnQueries(qc);

		expect(deploymentsCalls).toBe(2);
		expect(walletCalls).toBe(2);
		expect(result?.[0]?.name).toBe("Performance agent after checkout");
		expect(qc.getQueryData<{ balance_cents: number }>(billingKeys.wallet)?.balance_cents).toBe(
			5_000,
		);
		expect(qc.getQueryState(billingKeys.plans)?.isInvalidated).toBe(true);
		expect(qc.getQueryState(["agents"])?.isInvalidated).toBe(true);
	});
});

describe("checkout return parsing", () => {
	test("recognizes Stripe cancel returns as checkout markers", () => {
		expect(checkoutReturnWasCanceled("?checkout=cancel")).toBe(true);
		expect(checkoutReturnWasCanceled("?settings=billing-plan&checkout=cancel")).toBe(true);
		expect(checkoutReturnMarker("?checkout=cancel")).toBe("checkout=cancel");
	});

	test("does not treat passive checkout success copy as a refresh marker", () => {
		expect(checkoutReturnWasCanceled("?checkout=success")).toBe(false);
		expect(checkoutReturnMarker("?checkout=success")).toBeNull();
	});
});
