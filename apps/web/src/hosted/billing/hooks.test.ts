import { describe, expect, test } from "bun:test";
import {
	environmentManager,
	focusManager,
	QueryClient,
	QueryObserver,
} from "@tanstack/react-query";
import type {
	ComputeSubscriptionActionResult,
	DeploymentOperation,
	HostedComputeSubscription,
	HostedDeployment,
	HostedDeploymentStatus,
} from "@/hosted/billing/contracts";
import { BillingApiError, PlanChangeTerminalError } from "@/hosted/billing/errors";
import {
	applyDeploymentSubscriptionResult,
	applySubscriptionActionSuccess,
	billingKeys,
	billingNextPageParam,
	billingRecoveryRefetchIntervalFor,
	HOSTED_DEPLOYMENTS_REFRESH_POLICY,
	invalidateComputeSubscriptionInventory,
	invalidateSettledPlanChangeQueries,
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

function acceptedOperation(
	verb: DeploymentOperationVerb,
	targetGeneration = 2,
): DeploymentOperation {
	return {
		name: `operations/${verb}-failure`,
		metadata: {
			"@type": "type.googleapis.com/clawdi.v2.DeploymentOperationMetadata",
			deploymentId: "hdep_failure",
			verb: verb as DeploymentOperation["metadata"]["verb"],
			targetGeneration,
			manifestETag: "manifest-failure",
			createTime: "2026-07-25T00:00:00Z",
			updateTime: "2026-07-25T00:01:00Z",
		},
		done: false,
		response: null,
	};
}

describe("subscription pagination", () => {
	test("continues only with a complete server cursor", () => {
		expect(billingNextPageParam({ has_more: true, next_cursor: "cursor-next" })).toBe(
			"cursor-next",
		);
		expect(billingNextPageParam({ has_more: true, next_cursor: null })).toBeUndefined();
		expect(billingNextPageParam({ has_more: false, next_cursor: "cursor-stale" })).toBeUndefined();
	});
});

describe("plan change cache invalidation", () => {
	test("invalidates all billing inventory only after success or a terminal outcome", () => {
		const affectedKeys = [
			billingKeys.deployments,
			billingKeys.wallet,
			billingKeys.transactions,
			billingKeys.subscriptions,
		] as const;
		for (const error of [
			null,
			new PlanChangeTerminalError(409, "payment_method_required"),
		] as const) {
			const qc = new QueryClient();
			for (const queryKey of affectedKeys) qc.setQueryData(queryKey, { current: true });

			invalidateSettledPlanChangeQueries(qc, error);

			for (const queryKey of affectedKeys) {
				expect(qc.getQueryState(queryKey)?.isInvalidated).toBe(true);
			}
		}

		const pending = new QueryClient();
		for (const queryKey of affectedKeys) pending.setQueryData(queryKey, { current: true });
		invalidateSettledPlanChangeQueries(pending, new BillingApiError(503, "still processing"));
		for (const queryKey of affectedKeys) {
			expect(pending.getQueryState(queryKey)?.isInvalidated).toBe(false);
		}
	});
});

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
		expect(patched?.[0]?.commercial_display?.compute_subscription?.actions).toBeNull();
		expect(patched?.[0]?.start_action).toBeNull();
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

describe("applySubscriptionActionSuccess", () => {
	test("pending subscription actions invalidate inventory without projecting success", async () => {
		for (const action_state of ["pending", "reconciling"] as const) {
			const qc = new QueryClient();
			const previous = [hostedDeploymentFixture({ id: "dep_123" })];
			qc.setQueryData(billingKeys.deployments, previous);
			await applySubscriptionActionSuccess(
				qc,
				{ deployment_id: "dep_123" },
				{
					...subscriptionAction(true),
					action_state,
				},
			);
			expect(qc.getQueryData<HostedDeployment[]>(billingKeys.deployments)).toBe(previous);
			expect(qc.getQueryState(billingKeys.deployments)?.isInvalidated).toBe(true);
			qc.clear();
		}
	});

	test("invalidates every compute subscription inventory after an action", async () => {
		const qc = new QueryClient();
		qc.setQueryData(billingKeys.deployments, { current: true });
		qc.setQueryData(billingKeys.subscriptions, { current: true });
		qc.setQueryData(billingKeys.includedBasicAvailability, { available_slots: 0 });
		qc.setQueryData(billingKeys.reusableSubscriptions, { current: true });

		await applySubscriptionActionSuccess(
			qc,
			{ subscription_id: "csub_test" },
			subscriptionAction(true),
		);

		expect(qc.getQueryState(billingKeys.deployments)?.isInvalidated).toBe(true);
		expect(qc.getQueryState(billingKeys.subscriptions)?.isInvalidated).toBe(true);
		expect(qc.getQueryState(billingKeys.includedBasicAvailability)?.isInvalidated).toBe(true);
		expect(qc.getQueryState(billingKeys.reusableSubscriptions)?.isInvalidated).toBe(true);
	});

	test("refetches every inventory after scheduled cancellation settles", async () => {
		const fetches = new Map<string, number>();
		const qc = new QueryClient();
		for (const queryKey of [
			billingKeys.deployments,
			billingKeys.subscriptions,
			billingKeys.includedBasicAvailability,
			billingKeys.reusableSubscriptions,
		]) {
			const key = JSON.stringify(queryKey);
			await qc.fetchQuery({
				queryKey,
				queryFn: () => {
					fetches.set(key, (fetches.get(key) ?? 0) + 1);
					return { current: true };
				},
			});
		}

		await invalidateComputeSubscriptionInventory(qc, "all");

		for (const queryKey of [
			billingKeys.deployments,
			billingKeys.subscriptions,
			billingKeys.includedBasicAvailability,
			billingKeys.reusableSubscriptions,
		]) {
			expect(fetches.get(JSON.stringify(queryKey))).toBe(2);
		}
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
		const planSnapshots = [[{ id: "plan_before_checkout" }], [{ id: "plan_after_checkout" }]];
		const subscriptionSnapshots = [
			{ pages: [[{ id: "subscription_before_checkout" }]], pageParams: [null] },
			{ pages: [[{ id: "subscription_after_checkout" }]], pageParams: [null] },
		];
		let deploymentsCalls = 0;
		let walletCalls = 0;
		let plansCalls = 0;
		let subscriptionsCalls = 0;

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
		await qc.prefetchQuery({
			queryKey: billingKeys.plans,
			queryFn: async () => {
				plansCalls += 1;
				return planSnapshots.shift() ?? [{ id: "plan_after_checkout" }];
			},
		});
		await qc.prefetchQuery({
			queryKey: billingKeys.subscriptions,
			queryFn: async () => {
				subscriptionsCalls += 1;
				return (
					subscriptionSnapshots.shift() ?? {
						pages: [[{ id: "subscription_after_checkout" }]],
						pageParams: [null],
					}
				);
			},
		});
		qc.setQueryData(billingKeys.transactions, { pages: [], pageParams: [] });
		qc.setQueryData(["get", "/v1/agents"], [{ id: "agent_before_checkout" }]);

		const result = await refreshCheckoutReturnQueries(qc);

		expect(deploymentsCalls).toBe(2);
		expect(walletCalls).toBe(2);
		expect(plansCalls).toBe(2);
		expect(subscriptionsCalls).toBe(2);
		expect(result?.[0]?.resource.name).toBe("Performance agent after checkout");
		expect(qc.getQueryData<{ balance_cents: number }>(billingKeys.wallet)?.balance_cents).toBe(
			5_000,
		);
		expect(qc.getQueryData<Array<{ id: string }>>(billingKeys.plans)?.[0]?.id).toBe(
			"plan_after_checkout",
		);
		expect(
			qc.getQueryData<{ pages: Array<Array<{ id: string }>> }>(billingKeys.subscriptions)
				?.pages[0]?.[0]?.id,
		).toBe("subscription_after_checkout");
		expect(qc.getQueryState(billingKeys.transactions)?.isInvalidated).toBe(true);
		expect(qc.getQueryState(["get", "/v1/agents"])?.isInvalidated).toBe(true);
	});

	test("refreshes ancillary checkout state without invalidating a seeded deployment handoff", async () => {
		const qc = new QueryClient({
			defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
		});
		const authoritative = hostedDeploymentFixture({ id: "hdep_accepted", status: "creating" });
		let deploymentsCalls = 0;
		let walletCalls = 0;
		await qc.prefetchQuery({
			queryKey: billingKeys.deployments,
			queryFn: async () => {
				deploymentsCalls += 1;
				return [authoritative];
			},
		});
		await qc.prefetchQuery({
			queryKey: billingKeys.wallet,
			queryFn: async () => {
				walletCalls += 1;
				return { balance_cents: walletCalls };
			},
		});

		const result = await refreshCheckoutReturnQueries(qc, { includeDeployments: false });

		expect(deploymentsCalls).toBe(1);
		expect(walletCalls).toBe(2);
		expect(result).toEqual([authoritative]);
		expect(qc.getQueryState(billingKeys.deployments)?.isInvalidated).toBe(false);
		qc.clear();
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
	test("refreshes start advice while replacement funding is pending", () => {
		const waiting = hostedDeploymentFixture({
			status: "stopped",
			startAction: "wait",
			computeSubscription: {
				status: "canceled",
				payment_state: "ok",
				billing_term_months: 1,
				currency: "usd",
				cancel_at_period_end: false,
				recovery_action: "start_new",
			},
		});
		for (const snapshot of [waiting, { ...waiting, commercial_display: {} }]) {
			expect(billingRecoveryRefetchIntervalFor([snapshot], waiting.agent_id)).toBe(30_000);
		}
		expect(
			billingRecoveryRefetchIntervalFor(
				[{ ...waiting, start_action: "subscribe" }],
				waiting.agent_id,
			),
		).toBe(false);
	});

	test("keeps foreground reads active while commands or payments are pending", () => {
		for (const fields of [
			{ actions: { cancel: null, resume: false, command_state: "pending" as const } },
			{ actions: { cancel: null, resume: false, command_state: "reconciling" as const } },
			{ recovery_blocked_reason: "payment_pending" as const },
		]) {
			const pending = deployment({
				status: "active",
				billing_term_months: 1,
				payment_state: "ok",
				currency: "usd",
				cancel_at_period_end: false,
				...fields,
			});
			expect(billingRecoveryRefetchIntervalFor([pending], pending.resource.id)).toBe(30_000);
		}
	});
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

		const laterStartOperation = acceptedOperation("start", 4);
		const laterServerSnapshot = hostedDeploymentFixture({
			id: "hdep_delete",
			status: "starting",
			acceptedOperation: laterStartOperation,
		});
		laterServerSnapshot.resource.metadata.generation = 4;
		const [directlyAfterCancellation] = reconcileDeploymentSnapshots(
			[optimistic],
			[laterServerSnapshot],
		);
		expect(directlyAfterCancellation?.accepted_operation).toEqual(laterStartOperation);

		const [afterCancellation] = reconcileDeploymentSnapshots(
			[restoredServerSnapshot],
			[laterServerSnapshot],
		);
		expect(afterCancellation?.accepted_operation).toEqual(laterStartOperation);
	});

	test("lets a failed server snapshot override optimistic pending state without reusing its verb", () => {
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
			failedVerb: null,
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
