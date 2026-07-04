import { describe, expect, test } from "bun:test";
import {
	canRestart,
	canStart,
	canStop,
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
			"stopped",
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
			["stopped", "Stopped", "neutral"],
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

		for (const raw of ["creating", "starting", "deleting", "future_status"]) {
			const status = parseDeploymentStatus(raw);
			expect(isTerminalStatus(status)).toBe(false);
			expect(isTransitionalStatus(status)).toBe(true);
		}
	});

	test("drives lifecycle gates from hosted backend statuses", () => {
		const expectations = [
			["creating", false, false, false],
			["starting", false, true, true],
			["running", false, true, true],
			["stopped", true, false, false],
			["failed", true, false, true],
			["deleting", false, false, false],
			["deleted", false, false, false],
			["future_status", false, false, false],
		] as const;

		expect(isRunningStatus(parseDeploymentStatus("running"))).toBe(true);
		expect(isRunningStatus(parseDeploymentStatus("ready"))).toBe(true);
		expect(isRunningStatus(parseDeploymentStatus("stopped"))).toBe(false);

		for (const [raw, start, stop, restart] of expectations) {
			const status = parseDeploymentStatus(raw);
			expect(canStart(status)).toBe(start);
			expect(canStop(status)).toBe(stop);
			expect(canRestart(status)).toBe(restart);
		}
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
		expect(shouldPollDeployments([{ status: "running" }, { status: "deleting" }])).toBe(true);
		expect(shouldPollDeployments([{ status: "new_backend_status" }])).toBe(true);
		expect(shouldPollDeployments([])).toBe(false);
		expect(shouldPollDeployments(undefined)).toBe(false);
	});
});
