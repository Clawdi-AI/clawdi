import { describe, expect, test } from "bun:test";
import type { DeploymentOperation } from "@/hosted/billing/contracts";
import {
	canDelete,
	canQueryDeploymentProjection,
	canRestart,
	canStart,
	canStop,
	DEPLOYMENT_RECONCILIATION_POLL_INTERVAL_MS,
	DEPLOYMENT_TRANSITION_TIMEOUT_MS,
	DEPLOYMENT_TRANSITIONAL_POLL_INTERVAL_MS,
	deploymentPollingState,
	deploymentRefetchInterval,
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

function acceptedOperation(verb: DeploymentOperation["metadata"]["verb"]): DeploymentOperation {
	return {
		name: `operations/${verb}-polling`,
		metadata: {
			"@type": "type.googleapis.com/clawdi.v2.DeploymentOperationMetadata",
			deploymentId: "hdep_polling",
			verb,
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
		expect(status).toEqual({ kind: "unknown", raw: "queued_for_drain", known: false });
		expect(deploymentStatusLabel(status)).toBe("Queued For Drain");
		expect(deploymentStatusTone(status)).toBe("warning");
	});

	test("labels and tones the hosted backend statuses", () => {
		const expected = [
			["creating", "Provisioning", "info"],
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
		expect(shouldPollDeployments([])).toBe(false);
		expect(shouldPollDeployments(undefined)).toBe(false);
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

	test("drops fast polling immediately when a lifecycle operation reaches a terminal state", () => {
		const nowMs = Date.parse("2026-07-25T00:00:00Z");
		const operation = acceptedOperation("stop");
		const pending = deploymentPollingState(
			[
				hostedDeploymentFixture({
					id: "hdep_polling",
					status: "stopping",
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
					status: "stopped",
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

	test("stops at five minutes and distinguishes timeout from convergence", () => {
		const nowMs = Date.parse("2026-07-25T00:00:00Z");
		const deployment = hostedDeploymentFixture({
			id: "hdep_polling",
			status: "restarting",
			acceptedOperation: acceptedOperation("restart"),
		});
		const pending = deploymentPollingState([deployment], new Map(), nowMs);
		const timedOut = deploymentPollingState(
			[deployment],
			pending.trackers,
			nowMs + DEPLOYMENT_TRANSITION_TIMEOUT_MS,
		);

		expect(pending.transitions.get("hdep_polling")?.kind).toBe("converging");
		expect(timedOut.refetchInterval).toBe(false);
		expect(timedOut.transitions.get("hdep_polling")).toEqual({
			kind: "timed_out",
			verb: "restart",
			startedAtMs: nowMs,
		});
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
