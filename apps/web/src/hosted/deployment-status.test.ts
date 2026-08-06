import { describe, expect, test } from "bun:test";
import type { DeploymentOperation } from "@/hosted/billing/contracts";
import {
	canDelete,
	canQueryDeploymentProjection,
	canRestart,
	canStart,
	canStop,
	DEPLOYMENT_RECONCILIATION_POLL_INTERVAL_MS,
	DEPLOYMENT_TRANSITIONAL_POLL_INTERVAL_MS,
	type DeploymentOperationVerb,
	deploymentPollingState,
	deploymentRefetchInterval,
	deploymentRuntimeStatusPresentation,
	deploymentStatusFromResource,
	deploymentStatusLabel,
	deploymentStatusTone,
	isRunningStatus,
	isTerminalStatus,
	isTransitionalStatus,
	KNOWN_DEPLOYMENT_STATUSES,
	parseDeploymentStatus,
	shouldPollDeployments,
} from "@/hosted/deployment-status";
import { hostedDeploymentFixture } from "@/hosted/hosted-deployment.test-fixture";

function acceptedOperation(verb: DeploymentOperationVerb): DeploymentOperation {
	return {
		name: `operations/${verb}-polling`,
		metadata: {
			"@type": "type.googleapis.com/clawdi.v2.DeploymentOperationMetadata",
			deploymentId: "hdep_polling",
			verb: verb as DeploymentOperation["metadata"]["verb"],
			targetGeneration: 2,
			manifestETag: "manifest-polling",
			createTime: "2026-07-25T00:00:00Z",
			updateTime: "2026-07-25T00:00:00Z",
		},
		done: false,
		response: null,
	};
}

describe("DeploymentStatus", () => {
	test("matches the hosted backend deployment status enum", () => {
		expect(KNOWN_DEPLOYMENT_STATUSES).toEqual([
			"creating",
			"starting",
			"running",
			"stopping",
			"stopped",
			"restarting",
			"updating",
			"failed",
			"deleting",
			"deleted",
		]);
	});

	test("normalizes known hosted backend statuses", () => {
		for (const raw of KNOWN_DEPLOYMENT_STATUSES) {
			const status = parseDeploymentStatus(raw.toUpperCase());
			expect(status).toEqual({ kind: raw, raw, known: true });
		}
	});

	test("maps the ready legacy alias to running", () => {
		expect(parseDeploymentStatus(" ready ")).toEqual({
			kind: "running",
			raw: "running",
			known: true,
		});
	});

	test("preserves and labels unknown statuses", () => {
		const status = parseDeploymentStatus("queued_for_drain");
		expect(status).toEqual({
			kind: "unknown",
			raw: "queued_for_drain",
			known: false,
			reason: "unrecognized",
		});
		expect(deploymentStatusLabel(status)).toBe("Queued For Drain");
		expect(deploymentStatusTone(status)).toBe("warning");
	});

	test("models a missing authoritative status as its own unknown state", () => {
		const deployment = hostedDeploymentFixture({ status: null });
		const status = deploymentStatusFromResource(deployment.resource.status);

		expect(status).toEqual({
			kind: "unknown",
			raw: null,
			known: false,
			reason: "status_unavailable",
		});
		expect(deploymentStatusLabel(status)).toBe("Status unavailable");
		expect(deploymentStatusTone(status)).toBe("warning");
		expect(isRunningStatus(status)).toBe(false);
		expect(canStart(status)).toBe(false);
		expect(canStop(status)).toBe(false);
		expect(canRestart(status)).toBe(false);
		expect(canDelete(status)).toBe(true);
		expect(canQueryDeploymentProjection(status)).toBe(false);
	});

	test("labels and tones the hosted backend statuses", () => {
		const expected = [
			["creating", "Starting", "info"],
			["starting", "Starting", "info"],
			["running", "Running", "success"],
			["stopping", "Stopping", "info"],
			["stopped", "Stopped", "neutral"],
			["restarting", "Restarting", "success"],
			["updating", "Updating", "success"],
			["failed", "Failed", "destructive"],
			["deleting", "Deleting", "info"],
			["deleted", "Deleted", "neutral"],
		] as const;

		for (const [raw, label, tone] of expected) {
			const status = parseDeploymentStatus(raw);
			expect(deploymentStatusLabel(status)).toBe(label);
			expect(deploymentStatusTone(status)).toBe(tone);
		}
	});

	test("surfaces current post-ready runtime health degradation without changing lifecycle", () => {
		const deployment = hostedDeploymentFixture({ status: "running" });
		const status = deployment.resource.status;
		if (!status) throw new Error("Expected fixture status");
		const degradedStatus = {
			...status,
			conditions: [
				{
					type: "Degraded" as const,
					status: "True" as const,
					observedGeneration: status.observedGeneration,
					lastTransitionTime: "2026-08-02T12:00:00Z",
					reason: "RuntimeHealthDegraded",
					message: "Fresh runtime health is temporarily unavailable",
				},
			],
		};

		expect(deploymentRuntimeStatusPresentation(degradedStatus)).toEqual({
			status: { kind: "running", raw: "running", known: true },
			label: "Temporarily unavailable",
			tone: "warning",
		});
		expect(
			deploymentRuntimeStatusPresentation({
				...degradedStatus,
				conditions: [
					{ ...degradedStatus.conditions[0], observedGeneration: status.observedGeneration - 1 },
				],
			}).label,
		).toBe("Running");
	});

	test("classifies terminal and transitional states", () => {
		for (const raw of ["running", "stopped", "failed", "deleted"]) {
			const status = parseDeploymentStatus(raw);
			expect(isTerminalStatus(status)).toBe(true);
			expect(isTransitionalStatus(status)).toBe(false);
		}

		for (const raw of [
			"creating",
			"starting",
			"stopping",
			"restarting",
			"updating",
			"deleting",
			"future_status",
		]) {
			const status = parseDeploymentStatus(raw);
			expect(isTerminalStatus(status)).toBe(false);
			expect(isTransitionalStatus(status)).toBe(true);
		}
	});

	test("drives lifecycle gates from hosted backend statuses", () => {
		const expectations = [
			["creating", false, false, false],
			["starting", false, true, false],
			["running", false, true, true],
			["stopping", false, false, false],
			["stopped", true, false, false],
			["restarting", false, false, false],
			["updating", false, false, false],
			["failed", true, false, true],
			["deleting", false, false, false],
			["deleted", false, false, false],
			["future_status", false, false, false],
		] as const;

		expect(isRunningStatus(parseDeploymentStatus("running"))).toBe(true);
		expect(isRunningStatus(parseDeploymentStatus("ready"))).toBe(true);
		expect(isRunningStatus(parseDeploymentStatus("restarting"))).toBe(true);
		expect(isRunningStatus(parseDeploymentStatus("updating"))).toBe(true);
		expect(isRunningStatus(parseDeploymentStatus("stopped"))).toBe(false);
		expect(isRunningStatus(parseDeploymentStatus("stopping"))).toBe(false);

		for (const [raw, start, stop, restart] of expectations) {
			const status = parseDeploymentStatus(raw);
			expect(canStart(status)).toBe(start);
			expect(canStop(status)).toBe(stop);
			expect(canRestart(status)).toBe(restart);
		}
	});

	test("does not query a projection after stopped compute has released it", () => {
		expect(canQueryDeploymentProjection(parseDeploymentStatus("stopped"))).toBe(false);
		expect(canQueryDeploymentProjection(parseDeploymentStatus("deleted"))).toBe(false);
		expect(canQueryDeploymentProjection(parseDeploymentStatus("starting"))).toBe(true);
		expect(canQueryDeploymentProjection(parseDeploymentStatus("running"))).toBe(true);
		expect(canQueryDeploymentProjection(parseDeploymentStatus("failed"))).toBe(true);
	});

	test("disables delete once deletion is in progress or complete", () => {
		expect(canDelete(parseDeploymentStatus("running"))).toBe(true);
		expect(canDelete(parseDeploymentStatus("failed"))).toBe(true);
		expect(canDelete(parseDeploymentStatus("future_status"))).toBe(true);
		expect(canDelete(parseDeploymentStatus("deleting"))).toBe(false);
		expect(canDelete(parseDeploymentStatus("deleted"))).toBe(false);
	});

	test("classifies whether any deployment is non-terminal", () => {
		expect(
			shouldPollDeployments([
				{ status: "running" },
				{ status: "stopped" },
				{ status: "failed" },
				{ status: "deleted" },
			]),
		).toBe(false);
		expect(shouldPollDeployments([{ status: "running" }, { status: "creating" }])).toBe(true);
		expect(shouldPollDeployments([{ status: "running" }, { status: "starting" }])).toBe(true);
		expect(shouldPollDeployments([{ status: "running" }, { status: "stopping" }])).toBe(true);
		expect(shouldPollDeployments([{ status: "running" }, { status: "restarting" }])).toBe(true);
		expect(shouldPollDeployments([{ status: "running" }, { status: "updating" }])).toBe(true);
		expect(shouldPollDeployments([{ status: "running" }, { status: "deleting" }])).toBe(true);
		expect(shouldPollDeployments([{ status: "new_backend_status" }])).toBe(true);
		expect(shouldPollDeployments([{ status: null }])).toBe(true);
		expect(shouldPollDeployments([])).toBe(false);
		expect(shouldPollDeployments(undefined)).toBe(false);
	});

	test("polls a missing authoritative status on the bounded convergence cadence", () => {
		const nowMs = Date.parse("2026-07-25T00:00:00Z");
		const pending = deploymentPollingState(
			[hostedDeploymentFixture({ id: "hdep_unknown", status: null })],
			new Map(),
			nowMs,
		);

		expect(pending.refetchInterval).toBe(DEPLOYMENT_TRANSITIONAL_POLL_INTERVAL_MS);
		expect(pending.transitions.get("hdep_unknown")).toEqual({
			kind: "converging",
			verb: null,
			startedAtMs: nowMs,
		});
	});

	test("polls a lifecycle operation only while it is plausibly converging", () => {
		const nowMs = Date.parse("2026-07-25T00:00:00Z");
		const deployment = hostedDeploymentFixture({
			id: "hdep_polling",
			status: "starting",
			acceptedOperation: acceptedOperation("start"),
		});
		const pending = deploymentPollingState([deployment], new Map(), nowMs);

		expect(pending.refetchInterval).toBe(DEPLOYMENT_TRANSITIONAL_POLL_INTERVAL_MS);
		expect(pending.transitions.get("hdep_polling")).toEqual({
			kind: "converging",
			verb: "start",
			startedAtMs: nowMs,
		});
	});

	test("stops convergence polling when the accepted operation has failed", () => {
		const operation = acceptedOperation("create");
		operation.done = true;
		operation.error = { code: 5, message: "provider unavailable", details: [] };
		const failed = deploymentPollingState(
			[hostedDeploymentFixture({ status: "starting", acceptedOperation: operation })],
			new Map(),
			Date.parse("2026-07-27T00:00:00Z"),
		);

		expect(failed.refetchInterval).toBe(DEPLOYMENT_RECONCILIATION_POLL_INTERVAL_MS);
		expect(failed.transitions.size).toBe(0);
	});

	test("drops fast plan-change polling immediately when it reaches a terminal state", () => {
		const nowMs = Date.parse("2026-07-25T00:00:00Z");
		const operation = acceptedOperation("plan_change");
		const pending = deploymentPollingState(
			[
				hostedDeploymentFixture({
					id: "hdep_polling",
					status: "updating",
					acceptedOperation: operation,
				}),
			],
			new Map(),
			nowMs,
		);
		const terminal = deploymentPollingState(
			[
				hostedDeploymentFixture({
					id: "hdep_polling",
					status: "running",
					acceptedOperation: operation,
				}),
			],
			pending.trackers,
			nowMs + DEPLOYMENT_TRANSITIONAL_POLL_INTERVAL_MS,
		);

		expect(terminal.refetchInterval).toBe(DEPLOYMENT_RECONCILIATION_POLL_INTERVAL_MS);
		expect(terminal.refetchInterval).not.toBe(DEPLOYMENT_TRANSITIONAL_POLL_INTERVAL_MS);
		expect(terminal.transitions.size).toBe(0);
		expect(terminal.trackers.size).toBe(0);
	});

	test("keeps reconciling a create observed from 05:00 through Running at 05:09", () => {
		const acceptedAtMs = Date.parse("2026-07-29T05:00:00Z");
		const operation = acceptedOperation("create");
		operation.metadata.deploymentId = "hdep_slow_create";
		operation.metadata.createTime = "2026-07-29T05:00:00Z";
		operation.metadata.updateTime = "2026-07-29T05:00:00Z";
		const creating = hostedDeploymentFixture({
			id: "hdep_slow_create",
			status: "creating",
			acceptedOperation: operation,
		});
		const accepted = deploymentPollingState([creating], new Map(), acceptedAtMs);
		const lastFast = deploymentPollingState(
			[creating],
			accepted.trackers,
			Date.parse("2026-07-29T05:04:59Z"),
		);
		const delayed = deploymentPollingState(
			[creating],
			lastFast.trackers,
			Date.parse("2026-07-29T05:05:00Z"),
		);
		const running = deploymentPollingState(
			[
				hostedDeploymentFixture({
					id: "hdep_slow_create",
					status: "running",
					acceptedOperation: operation,
				}),
			],
			delayed.trackers,
			Date.parse("2026-07-29T05:09:00Z"),
		);

		expect([accepted.refetchInterval, lastFast.refetchInterval]).toEqual([
			DEPLOYMENT_TRANSITIONAL_POLL_INTERVAL_MS,
			DEPLOYMENT_TRANSITIONAL_POLL_INTERVAL_MS,
		]);
		expect(delayed.refetchInterval).toBe(DEPLOYMENT_RECONCILIATION_POLL_INTERVAL_MS);
		expect(delayed.transitions.get("hdep_slow_create")?.kind).toBe("timed_out");
		expect(running.refetchInterval).toBe(DEPLOYMENT_RECONCILIATION_POLL_INTERVAL_MS);
		expect(running.transitions.size).toBe(0);
		expect(running.trackers.size).toBe(0);
	});

	test("schedules a modest reconciliation interval for steady inventory", () => {
		const deployments = [
			hostedDeploymentFixture({ status: "running" }),
			hostedDeploymentFixture({ id: "hdep_stopped", status: "stopped" }),
			hostedDeploymentFixture({ id: "hdep_failed", status: "failed" }),
		];
		expect(deploymentRefetchInterval(deployments)).toBe(DEPLOYMENT_RECONCILIATION_POLL_INTERVAL_MS);
		expect(DEPLOYMENT_RECONCILIATION_POLL_INTERVAL_MS).toBe(60_000);
	});
});
