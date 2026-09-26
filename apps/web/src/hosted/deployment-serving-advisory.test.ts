import { describe, expect, test } from "bun:test";
import type { HostedDeploymentStatus } from "@/hosted/billing/contracts";
import { deploymentFailurePresentation } from "@/hosted/deployment-failure";
import {
	currentServingAdvisory,
	DEPLOYMENT_RECONCILIATION_POLL_INTERVAL_MS,
	DEPLOYMENT_TRANSITIONAL_POLL_INTERVAL_MS,
	deploymentAwaitingRuntimeUi,
	deploymentPollingState,
	deploymentRuntimeStatusPresentation,
	deploymentRuntimeUiIsReady,
	deploymentRuntimeUiWithdrawn,
	deploymentStatusFromResource,
	deploymentTerminalIsAvailable,
	isRunningStatus,
} from "@/hosted/deployment-status";
import { hostedDeploymentFixture } from "@/hosted/hosted-deployment.test-fixture";

type Condition = HostedDeploymentStatus["conditions"][number];

function degraded(reason: string, observedGeneration = 1): Condition {
	return {
		type: "Degraded",
		status: "True",
		observedGeneration,
		reason,
		message: "Advisory",
		lastTransitionTime: "2026-09-26T00:00:00Z",
	};
}

function servingDeployment(reason: string, observedGeneration = 1) {
	return hostedDeploymentFixture({
		runtime: "hermes",
		runtimeUiEndpoint: {
			runtime: "hermes",
			role: "control_ui",
			url: "https://runtime.example/",
			auth_mode: "oidc",
			browser_session_url:
				"https://api.example.test/v2/deployments/hdep_fixture/hermes-oidc/session",
			access_revision: 1,
			browser_mode: "embedded_and_top_level",
			component_readiness: 1,
		},
		extraConditions: [degraded(reason, observedGeneration)],
	});
}

describe("serving advisories", () => {
	test.each(["ProviderConflict", "RuntimeUiUnavailable", "SomeFutureAdvisory"])(
		"Ready=True with Degraded %s renders as running, never failed",
		(reason) => {
			const deployment = servingDeployment(reason);
			const status = deploymentStatusFromResource(deployment.resource.status);

			expect(isRunningStatus(status)).toBe(true);
			expect(deploymentRuntimeStatusPresentation(deployment.resource.status)).toEqual({
				status: { kind: "running", raw: "running", known: true },
				label: "Running",
				tone: "success",
			});
			expect(deploymentFailurePresentation(deployment)).toBeNull();
			expect(deploymentTerminalIsAvailable(deployment)).toBe(true);
		},
	);

	test("recognizes only current-generation advisory reasons", () => {
		expect(currentServingAdvisory(servingDeployment("ProviderConflict").resource.status)).toBe(
			"ProviderConflict",
		);
		expect(currentServingAdvisory(servingDeployment("RuntimeUiUnavailable").resource.status)).toBe(
			"RuntimeUiUnavailable",
		);
		expect(
			currentServingAdvisory(servingDeployment("RuntimeUiUnavailable", 0).resource.status),
		).toBeNull();
		expect(currentServingAdvisory(servingDeployment("RuntimeHealthDegraded").resource.status)).toBe(
			null,
		);
		expect(currentServingAdvisory(null)).toBeNull();
	});

	test("a withdrawn dashboard blocks the browser UI even with component readiness", () => {
		const withdrawn = servingDeployment("RuntimeUiUnavailable");
		expect(deploymentRuntimeUiWithdrawn(withdrawn.resource.status)).toBe(true);
		expect(deploymentRuntimeUiIsReady(withdrawn)).toBe(false);

		// Provider conflicts leave the dashboard usable; stale advisories never block it.
		expect(deploymentRuntimeUiIsReady(servingDeployment("ProviderConflict"))).toBe(true);
		expect(deploymentRuntimeUiIsReady(servingDeployment("RuntimeUiUnavailable", 0))).toBe(true);
	});

	test("does not fast-poll for a dashboard the runtime has withdrawn", () => {
		const withdrawn = servingDeployment("RuntimeUiUnavailable");
		expect(deploymentAwaitingRuntimeUi(withdrawn)).toBe(false);
		const state = deploymentPollingState([withdrawn], new Map(), Date.now());
		expect(state.refetchInterval).toBe(DEPLOYMENT_RECONCILIATION_POLL_INTERVAL_MS);
		expect(state.transitions.size).toBe(0);

		// A running agent that simply has no endpoint yet keeps converging.
		const pending = hostedDeploymentFixture({ status: "running" });
		expect(deploymentAwaitingRuntimeUi(pending)).toBe(true);
		expect(deploymentPollingState([pending], new Map(), Date.now()).refetchInterval).toBe(
			DEPLOYMENT_TRANSITIONAL_POLL_INTERVAL_MS,
		);
	});
});
