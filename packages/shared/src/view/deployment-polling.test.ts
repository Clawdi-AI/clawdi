import { describe, expect, test } from "bun:test";
import type {
	DeployComponents,
	HostedDeployOperation as DeploymentOperation,
	DeploymentRead as HostedDeployment,
} from "../api";
import { deploymentFailureProjection } from "./deployment-failure";
import {
	billingRecoveryRefetchIntervalFor,
	reconcileDeploymentSnapshots,
	shortestRefetchInterval,
	upsertAuthoritativeDeployment,
} from "./deployment-polling";
import { hostedDeploymentFixture } from "./hosted-deployment.test-fixture";

type HostedDeploymentStatus = DeployComponents["schemas"]["HostedDeploymentStatus"];
type HostedComputeSubscription = NonNullable<
	NonNullable<HostedDeployment["commercial_display"]>["compute_subscription"]
>;

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

function acceptedOperation(
	verb: DeploymentOperation["metadata"]["verb"],
	targetGeneration = 2,
): DeploymentOperation {
	return {
		name: `operations/${verb}-failure`,
		metadata: {
			"@type": "type.googleapis.com/clawdi.v2.DeploymentOperationMetadata",
			deploymentId: "hdep_failure",
			verb,
			targetGeneration,
			manifestETag: "manifest-failure",
			createTime: "2026-07-25T00:00:00Z",
			updateTime: "2026-07-25T00:01:00Z",
		},
		done: false,
		response: null,
	};
}

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

	test("refreshes action-required payments by Agent or deployment identity", () => {
		const requiresAction = deployment({
			status: "active",
			payment_state: "requires_action",
			billing_term_months: 1,
			currency: "usd",
			cancel_at_period_end: false,
		});
		for (const target of [requiresAction.agent_id, requiresAction.resource.id.toUpperCase()]) {
			expect(billingRecoveryRefetchIntervalFor([requiresAction], target)).toBe(30_000);
		}
		expect(billingRecoveryRefetchIntervalFor([requiresAction], null)).toBe(false);
		expect(billingRecoveryRefetchIntervalFor(undefined, requiresAction.agent_id)).toBe(false);
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
				"The Clawdi service couldn't confirm the plan change. Your plan was not changed and you were not charged.",
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

test("combines transition and billing polling at the shortest active interval", () => {
	for (const [intervals, expected] of [
		[[], false],
		[[false, false], false],
		[[60_000, 30_000], 30_000],
		[[10_000, 30_000], 10_000],
		[[false, 30_000], 30_000],
	] satisfies [Array<number | false>, number | false][]) {
		expect(shortestRefetchInterval(...intervals)).toBe(expected);
	}
});

test("authoritative acceptance adds or replaces one Agent without dropping other Agents", () => {
	const existing = hostedDeploymentFixture({ id: "dep_existing" });
	const stale = hostedDeploymentFixture({ id: "dep_new", status: "creating" });
	const authoritative = hostedDeploymentFixture({ id: "dep_new", status: "running" });
	expect(upsertAuthoritativeDeployment(undefined, authoritative)).toEqual([authoritative]);
	expect(upsertAuthoritativeDeployment([], authoritative)).toEqual([authoritative]);
	expect(upsertAuthoritativeDeployment([existing], authoritative)).toEqual([
		existing,
		authoritative,
	]);
	expect(upsertAuthoritativeDeployment([stale, existing], authoritative)).toEqual([
		authoritative,
		existing,
	]);
	expect(stale.resource.status?.summary_state).toBe("creating");
});
