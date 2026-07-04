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
	test("normalizes known deploy-api statuses", () => {
		for (const raw of KNOWN_DEPLOYMENT_STATUSES) {
			const status = parseDeploymentStatus(raw.toUpperCase());
			expect(status).toEqual({ kind: raw, raw, known: true });
		}
	});

	test("preserves and labels unknown statuses", () => {
		const status = parseDeploymentStatus("queued_for_drain");
		expect(status).toEqual({ kind: "unknown", raw: "queued_for_drain", known: false });
		expect(deploymentStatusLabel(status)).toBe("Queued For Drain");
		expect(deploymentStatusTone(status)).toBe("warning");
	});

	test("labels and tones known statuses", () => {
		expect(deploymentStatusLabel(parseDeploymentStatus("ready"))).toBe("Ready");
		expect(deploymentStatusLabel(parseDeploymentStatus("error"))).toBe("Failed");
		expect(deploymentStatusTone(parseDeploymentStatus("running"))).toBe("success");
		expect(deploymentStatusTone(parseDeploymentStatus("stopped"))).toBe("neutral");
		expect(deploymentStatusTone(parseDeploymentStatus("failed"))).toBe("destructive");
		expect(deploymentStatusTone(parseDeploymentStatus("restarting"))).toBe("info");
	});

	test("classifies terminal and transitional states", () => {
		for (const raw of ["running", "ready", "stopped", "failed", "error"]) {
			const status = parseDeploymentStatus(raw);
			expect(isTerminalStatus(status)).toBe(true);
			expect(isTransitionalStatus(status)).toBe(false);
		}

		for (const raw of [
			"pending",
			"provisioning",
			"starting",
			"stopping",
			"restarting",
			"deleting",
			"future_status",
		]) {
			const status = parseDeploymentStatus(raw);
			expect(isTerminalStatus(status)).toBe(false);
			expect(isTransitionalStatus(status)).toBe(true);
		}
	});

	test("drives lifecycle gates from recoverable statuses", () => {
		expect(isRunningStatus(parseDeploymentStatus("running"))).toBe(true);
		expect(isRunningStatus(parseDeploymentStatus("ready"))).toBe(true);
		expect(canStop(parseDeploymentStatus("running"))).toBe(true);
		expect(canStop(parseDeploymentStatus("starting"))).toBe(true);
		expect(canStart(parseDeploymentStatus("stopped"))).toBe(true);
		expect(canStart(parseDeploymentStatus("failed"))).toBe(true);
		expect(canStart(parseDeploymentStatus("error"))).toBe(true);
		expect(canStart(parseDeploymentStatus("starting"))).toBe(false);
		expect(canRestart(parseDeploymentStatus("ready"))).toBe(true);
		expect(canRestart(parseDeploymentStatus("starting"))).toBe(true);
		expect(canRestart(parseDeploymentStatus("failed"))).toBe(true);
		expect(canRestart(parseDeploymentStatus("restarting"))).toBe(false);
		expect(canRestart(parseDeploymentStatus("future_status"))).toBe(false);
	});

	test("polls while any deployment is non-terminal", () => {
		expect(shouldPollDeployments([{ status: "running" }, { status: "stopped" }])).toBe(false);
		expect(shouldPollDeployments([{ status: "running" }, { status: "restarting" }])).toBe(true);
		expect(shouldPollDeployments([{ status: "new_backend_status" }])).toBe(true);
		expect(shouldPollDeployments([])).toBe(false);
		expect(shouldPollDeployments(undefined)).toBe(false);
	});
});
