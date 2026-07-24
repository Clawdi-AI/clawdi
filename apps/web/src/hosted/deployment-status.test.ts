import { describe, expect, test } from "bun:test";
import {
	canDelete,
	canRestart,
	canStart,
	canStop,
	DEPLOYMENT_RECONCILIATION_POLL_INTERVAL_MS,
	DEPLOYMENT_TRANSITIONAL_POLL_INTERVAL_MS,
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

	test("disables delete once deletion is in progress or complete", () => {
		expect(canDelete(parseDeploymentStatus("running"))).toBe(true);
		expect(canDelete(parseDeploymentStatus("failed"))).toBe(true);
		expect(canDelete(parseDeploymentStatus("deleting"))).toBe(false);
		expect(canDelete(parseDeploymentStatus("deleted"))).toBe(false);
	});

	test("polls while any deployment is non-terminal", () => {
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
		expect(deploymentRefetchInterval([{ status: "running" }])).toBe(
			DEPLOYMENT_RECONCILIATION_POLL_INTERVAL_MS,
		);
		expect(deploymentRefetchInterval([{ status: "starting" }])).toBe(
			DEPLOYMENT_TRANSITIONAL_POLL_INTERVAL_MS,
		);
	});
});
