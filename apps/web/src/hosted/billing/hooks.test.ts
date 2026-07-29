import { describe, expect, test } from "bun:test";
import {
	environmentManager,
	focusManager,
	QueryClient,
	QueryObserver,
} from "@tanstack/react-query";
import { checkoutReturnMarker, checkoutReturnWasCanceled } from "@/hosted/billing/checkout-return";
import type {
	ComputeSubscriptionActionResult,
	DeploymentOperation,
	HostedComputeSubscription,
	HostedDeployment,
	HostedDeploymentStatus,
} from "@/hosted/billing/contracts";
import {
	applyDeploymentSubscriptionResult,
	billingKeys,
	billingRecoveryRefetchIntervalFor,
	HOSTED_DEPLOYMENTS_REFRESH_POLICY,
	reconcileDeploymentSnapshots,
	refreshCheckoutReturnQueries,
} from "@/hosted/billing/hooks";
import { deploymentFailureProjection } from "@/hosted/deployment-failure";
import {
	DEPLOYMENT_RECONCILIATION_POLL_INTERVAL_MS,
	type DeploymentOperationVerb,
} from "@/hosted/deployment-status";
import { hostedDeploymentFixture } from "@/hosted/hosted-deployment.test-fixture";

function requiredDeploymentStatus(
	deployment: HostedDeployment | undefined,
): HostedDeploymentStatus {
	if (!deployment) throw new Error("Expected deployment fixture");
	const status = deployment.resource.status;
	if (status === null) throw new Error("Expected deployment status fixture");
	return status;
}

function deployment(
	computeSubscription: HostedComputeSubscription,
	id = "dep_123",
): HostedDeployment {
	return hostedDeploymentFixture({
		id,
		name: "Performance agent",
		createdAt: "2026-06-22T00:00:00Z",
		computeSubscription,
	});
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

function acceptedOperation(verb: DeploymentOperationVerb): DeploymentOperation {
	return {
		name: `operations/${verb}-failure`,
		metadata: {
			"@type": "type.googleapis.com/clawdi.v2.DeploymentOperationMetadata",
			deploymentId: "hdep_failure",
			verb: verb as DeploymentOperation["metadata"]["verb"],
			targetGeneration: 2,
			manifestETag: "manifest-failure",
			createTime: "2026-07-25T00:00:00Z",
			updateTime: "2026-07-25T00:01:00Z",
		},
		done: false,
		response: null,
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
		expect(patched?.[0]?.commercial_display?.compute_subscription?.cancel_at_period_end).toBe(true);
		expect(patched?.[0]?.commercial_display?.compute_subscription?.billing_term_months).toBe(12);
		expect(qc.getQueryState(billingKeys.deployments)?.isInvalidated).toBe(false);

		applyDeploymentSubscriptionResult(qc, "dep_123", subscriptionAction(false));

		patched = qc.getQueryData<HostedDeployment[]>(billingKeys.deployments);
		expect(patched?.[0]?.commercial_display?.compute_subscription?.cancel_at_period_end).toBe(
			false,
		);
		expect(patched?.[0]?.commercial_display?.compute_subscription?.cancel_at).toBeNull();
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
		const afterCheckout = hostedDeploymentFixture({
			id: beforeCheckout.resource.id,
			name: "Performance agent after checkout",
			computeSubscription: {
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
		});
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
		expect(result?.[0]?.resource.spec.name).toBe("Performance agent after checkout");
		expect(qc.getQueryData<{ balance_cents: number }>(billingKeys.wallet)?.balance_cents).toBe(
			5_000,
		);
		expect(qc.getQueryState(billingKeys.plans)?.isInvalidated).toBe(true);
		expect(qc.getQueryState(["agents"])?.isInvalidated).toBe(true);
	});

	test("rejects instead of claiming success when the required wallet refresh fails", async () => {
		const qc = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		let walletRefreshShouldFail = false;
		await qc.prefetchQuery({
			queryKey: billingKeys.deployments,
			queryFn: async () => [],
		});
		await qc.prefetchQuery({
			queryKey: billingKeys.wallet,
			queryFn: async () => {
				if (walletRefreshShouldFail) throw new Error("wallet refresh failed");
				return { balance_cents: 1_000 };
			},
		});
		walletRefreshShouldFail = true;

		await expect(refreshCheckoutReturnQueries(qc)).rejects.toThrow(
			"Couldn’t refresh required checkout return data.",
		);
	});
});

describe("billingRecoveryRefetchIntervalFor", () => {
	test("polls only the visible past-due deployment", () => {
		const due = deployment(
			{
				status: "past_due",
				funding_source: "wallet",
				payment_state: "past_due",
				recovery_action: "top_up",
				billing_term_months: 1,
				price_cents: 900,
				currency: "usd",
				cancel_at_period_end: false,
			},
			"hdep_due",
		);
		expect(billingRecoveryRefetchIntervalFor([due], "hdep_due")).toBe(30_000);
		expect(billingRecoveryRefetchIntervalFor([due], "hdep_other")).toBe(false);
	});

	test("does not derive polling from a local renewal boundary", () => {
		const active = deployment(
			{
				status: "active",
				funding_source: "wallet",
				payment_state: "ok",
				billing_term_months: 1,
				price_cents: 900,
				currency: "usd",
				cancel_at_period_end: false,
				current_period_end: "2026-07-16T00:00:30Z",
			},
			"hdep_active",
		);
		expect(billingRecoveryRefetchIntervalFor([active], active.resource.id)).toBe(false);
	});

	test("does not poll terminal wallet states", () => {
		const unpaid = deployment(
			{
				status: "unpaid",
				funding_source: "wallet",
				payment_state: "unpaid",
				recovery_action: "top_up",
				billing_term_months: 1,
				price_cents: 900,
				currency: "usd",
				cancel_at_period_end: false,
				current_period_end: "2026-07-16T00:00:00Z",
			},
			"hdep_unpaid",
		);
		expect(billingRecoveryRefetchIntervalFor([unpaid], unpaid.resource.id)).toBe(false);
	});
});

describe("hosted deployment refresh policy", () => {
	test("uses TanStack focus state to pause steady refreshes in a background tab", async () => {
		expect(DEPLOYMENT_RECONCILIATION_POLL_INTERVAL_MS).toBe(60_000);
		expect(HOSTED_DEPLOYMENTS_REFRESH_POLICY).toEqual({
			refetchIntervalInBackground: false,
			refetchOnWindowFocus: true,
		});

		environmentManager.setIsServer(() => false);
		focusManager.setFocused(false);
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		let calls = 0;
		const observer = new QueryObserver(queryClient, {
			queryKey: ["test", "hosted-deployment-foreground-refresh"],
			queryFn: async () => {
				calls += 1;
				return [];
			},
			refetchInterval: 5,
			...HOSTED_DEPLOYMENTS_REFRESH_POLICY,
		});
		const unsubscribe = observer.subscribe(() => undefined);

		try {
			await Bun.sleep(20);
			expect(calls).toBe(1);

			focusManager.setFocused(true);
			for (let attempt = 0; attempt < 20 && calls === 1; attempt += 1) {
				await Bun.sleep(5);
			}
			expect(calls).toBeGreaterThan(1);
		} finally {
			unsubscribe();
			queryClient.clear();
			focusManager.setFocused(undefined);
			environmentManager.setIsServer(() => typeof window === "undefined");
		}
	});
});

describe("reconcileDeploymentSnapshots", () => {
	test("retains accepted delete intent across stale reads so a dismissed agent cannot reappear", () => {
		const accepted = acceptedOperation("delete");
		const optimistic = hostedDeploymentFixture({
			id: "hdep_delete",
			status: "deleting",
			acceptedOperation: accepted,
		});
		const staleServerSnapshot = hostedDeploymentFixture({
			id: "hdep_delete",
			status: "running",
			acceptedOperation: acceptedOperation("start"),
		});

		const [reconciled] = reconcileDeploymentSnapshots([optimistic], [staleServerSnapshot]);

		expect(reconciled?.resource.status?.summary_state).toBe("running");
		expect(reconciled?.accepted_operation).toEqual(accepted);

		const [reconciledWithoutOperation] = reconcileDeploymentSnapshots(
			[optimistic],
			[
				hostedDeploymentFixture({
					id: "hdep_delete",
					status: "running",
					acceptedOperation: null,
				}),
			],
		);
		expect(reconciledWithoutOperation?.accepted_operation).toEqual(accepted);
	});

	test("converges a delete when the same operation becomes terminal and cancelled", () => {
		const accepted = acceptedOperation("delete");
		const optimistic = hostedDeploymentFixture({
			id: "hdep_delete",
			status: "deleting",
			acceptedOperation: accepted,
		});
		const cancelledOperation: DeploymentOperation = {
			...accepted,
			done: true,
			error: {
				code: 1,
				message: "Delete was cancelled before teardown.",
				details: [],
			},
			response: null,
		};
		const restoredServerSnapshot = hostedDeploymentFixture({
			id: "hdep_delete",
			status: "running",
			acceptedOperation: cancelledOperation,
			computeSlotOccupancy: {
				occupies_slot: true,
				backing_infra: "present",
				reason: "backing_infra_present",
			},
		});

		const [reconciled] = reconcileDeploymentSnapshots([optimistic], [restoredServerSnapshot]);

		expect(reconciled).toEqual(restoredServerSnapshot);
		expect(reconciled?.accepted_operation?.done).toBe(true);
		expect(reconciled?.accepted_operation?.error?.code).toBe(1);

		const laterStartOperation = acceptedOperation("start");
		const laterServerSnapshot = hostedDeploymentFixture({
			id: "hdep_delete",
			status: "starting",
			acceptedOperation: laterStartOperation,
		});
		const [afterCancellation] = reconcileDeploymentSnapshots(
			[restoredServerSnapshot],
			[laterServerSnapshot],
		);
		expect(afterCancellation?.accepted_operation).toEqual(laterStartOperation);
	});

	test("lets a failed server snapshot override optimistic pending state and retain its verb", () => {
		const optimistic = hostedDeploymentFixture({
			id: "hdep_failure",
			status: "updating",
			acceptedOperation: acceptedOperation("plan_change"),
		});
		const actionableReason =
			"Re-quote the plan change and try again. Operation ID: operations/plan_change-failure.";
		const failure = {
			type: "https://api.clawdi.ai/problems/operation_aborted",
			title: "Deployment operation was aborted",
			status: 409,
			detail: actionableReason,
			instance: "hdep_failure",
			code: "operation_aborted",
			phase: "plan_change",
			retryable: false,
			conditionReason: "OperationAborted",
			conditionMessage: "Deployment operation was aborted",
			observedGeneration: 2,
		};
		const serverSnapshot = hostedDeploymentFixture({
			id: "hdep_failure",
			status: "failed",
			failure,
			acceptedOperation: null,
		});

		const [reconciled] = reconcileDeploymentSnapshots([optimistic], [serverSnapshot]);
		const reconciledStatus = requiredDeploymentStatus(reconciled);

		expect(reconciledStatus.summary_state).toBe("failed");
		expect(reconciledStatus.failure).toEqual(failure);
		expect(deploymentFailureProjection(reconciled)).toEqual({
			reason:
				"The Clawdi service could not confirm the plan change. Your plan was not changed and you were not charged.",
			failedVerb: "plan_change",
			retryable: false,
			code: "operation_aborted",
		});
	});

	test("retains accepted operation context without fabricating unavailable status", () => {
		const accepted = acceptedOperation("update");
		const optimistic = hostedDeploymentFixture({
			id: "hdep_unknown",
			status: "updating",
			acceptedOperation: accepted,
		});
		const serverSnapshot = hostedDeploymentFixture({
			id: "hdep_unknown",
			status: null,
			acceptedOperation: null,
		});

		const [reconciled] = reconcileDeploymentSnapshots([optimistic], [serverSnapshot]);

		expect(reconciled?.resource.status).toBeNull();
		expect(reconciled?.accepted_operation).toEqual(accepted);
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
