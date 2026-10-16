import { describe, expect, test } from "bun:test";
import { deploymentPrimaryLifecycleAction } from "./agent-settings";
import { computeStatusDetailsPresentation } from "./compute-status-details";
import { parseDeploymentStatus } from "./deployment-status";
import { hostedDeploymentFixture } from "./hosted-deployment.test-fixture";
import { agentTerminalPresentation } from "./runtime-console";

describe("deploymentPrimaryLifecycleAction", () => {
	test("offers Stop while the agent runs or is changing, and Start otherwise", () => {
		for (const state of ["running", "starting", "stopping", "restarting", "updating"])
			expect(deploymentPrimaryLifecycleAction(parseDeploymentStatus(state))).toBe("stop");
		for (const state of ["stopped", "failed", "creating", "deleting", "mystery"])
			expect(deploymentPrimaryLifecycleAction(parseDeploymentStatus(state))).toBe("start");
	});
});

describe("computeStatusDetailsPresentation", () => {
	const quiet = { timedOut: false, escalated: false };

	test("a stuck change offers cancellation, but a failure or restart outranks a slow one", () => {
		expect(
			computeStatusDetailsPresentation(hostedDeploymentFixture({ status: "starting" }), {
				timedOut: true,
				escalated: true,
			}),
		).toMatchObject({ description: expect.stringContaining("stuck"), cancel: true });
		expect(
			computeStatusDetailsPresentation(hostedDeploymentFixture({ status: "restarting" }), {
				timedOut: true,
				escalated: false,
			}),
		).toMatchObject({ description: "Restarting", cancel: false });
		expect(
			computeStatusDetailsPresentation(hostedDeploymentFixture({ status: "failed" }), {
				timedOut: true,
				escalated: true,
			}),
		).toMatchObject({ tone: "destructive", cancel: false });
	});

	test("a running agent has no status line; a stopped one names its unavailable dashboard", () => {
		expect(computeStatusDetailsPresentation(hostedDeploymentFixture(), quiet)).toBeNull();
		expect(
			computeStatusDetailsPresentation(
				hostedDeploymentFixture({ status: "stopped", runtime: "hermes" }),
				quiet,
			)?.description,
		).toBe("Agent is stopped. Channels and Hermes Dashboard are unavailable.");
	});
});

describe("agentTerminalPresentation", () => {
	test("connects only when the terminal is available and explains every other state", () => {
		expect(agentTerminalPresentation(hostedDeploymentFixture()).state).toBe("available");
		expect(agentTerminalPresentation(hostedDeploymentFixture({ status: "stopped" }))).toMatchObject(
			{ state: "stopped", title: "Stopped" },
		);
		expect(
			agentTerminalPresentation(hostedDeploymentFixture({ status: "starting" })),
		).toMatchObject({ state: "starting", title: "Starting your agent…" });
		expect(
			agentTerminalPresentation(hostedDeploymentFixture({ status: "deleting" })).description,
		).toBe("Start the agent to open a terminal. Current status: deleting.");
	});
});
