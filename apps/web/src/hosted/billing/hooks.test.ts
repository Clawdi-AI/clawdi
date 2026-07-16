import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import type { ComputeSubscriptionActionResult, HostedDeployment } from "@/hosted/billing/contracts";
import {
	applyDeploymentSubscriptionResult,
	billingKeys,
	checkoutReturnMarker,
	checkoutReturnWasCanceled,
	refreshCheckoutReturnQueries,
	shouldPollWalletDunningFor,
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
		funding_source: "stripe",
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
				funding_source: "stripe",
				payment_state: "ok",
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
			funding_source: "stripe",
			payment_state: "ok",
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
				funding_source: "stripe",
				payment_state: "ok",
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

describe("shouldPollWalletDunningFor", () => {
	const now = Date.parse("2026-07-16T00:00:00Z");

	test("polls only the visible wallet grace deployment", () => {
		const due = deployment({
			status: "past_due",
			funding_source: "wallet",
			payment_state: "past_due",
			recovery_action: "top_up",
			billing_term_months: 1,
			price_cents: 900,
			currency: "usd",
			cancel_at_period_end: false,
		});
		due.id = "hdep_due";
		expect(shouldPollWalletDunningFor([due], "hdep_due", now)).toBe(true);
		expect(shouldPollWalletDunningFor([due], "hdep_other", now)).toBe(false);
	});

	test("starts before an active wallet collection boundary and stops after settlement", () => {
		const active = deployment({
			status: "active",
			funding_source: "wallet",
			payment_state: "ok",
			billing_term_months: 1,
			price_cents: 900,
			currency: "usd",
			cancel_at_period_end: false,
			current_period_end: "2026-07-16T00:00:30Z",
		});
		active.id = "hdep_active";
		expect(shouldPollWalletDunningFor([active], active.id, now)).toBe(true);

		if (active.compute_subscription) {
			active.compute_subscription.current_period_end = "2026-08-16T00:00:00Z";
		}
		expect(shouldPollWalletDunningFor([active], active.id, now)).toBe(false);
	});

	test("does not poll terminal wallet states", () => {
		const unpaid = deployment({
			status: "unpaid",
			funding_source: "wallet",
			payment_state: "unpaid",
			recovery_action: "top_up",
			billing_term_months: 1,
			price_cents: 900,
			currency: "usd",
			cancel_at_period_end: false,
			current_period_end: "2026-07-16T00:00:00Z",
		});
		unpaid.id = "hdep_unpaid";
		expect(shouldPollWalletDunningFor([unpaid], unpaid.id, now)).toBe(false);
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
