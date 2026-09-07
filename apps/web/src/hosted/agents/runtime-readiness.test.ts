import { expect, test } from "bun:test";
import {
	DEPLOYMENT_RECONCILIATION_POLL_INTERVAL_MS,
	DEPLOYMENT_TRANSITION_TIMEOUT_MS,
	DEPLOYMENT_TRANSITIONAL_POLL_INTERVAL_MS,
	deploymentPollingState,
	deploymentRuntimeUiIsReady,
} from "@/hosted/deployment-status";
import { hostedDeploymentFixture } from "@/hosted/hosted-deployment.test-fixture";

function readyDeployment() {
	return hostedDeploymentFixture({
		runtime: "hermes",
		runtimeUiEndpoint: {
			runtime: "hermes",
			role: "control_ui",
			url: "https://runtime.example/",
			auth_mode: "password",
			browser_mode: "embedded_and_top_level",
		},
	});
}

test("launch eligibility requires current runtime evidence and a published endpoint, not cloud projection", () => {
	const deployment = readyDeployment();
	const status = deployment.resource.status;
	if (!status) throw new Error("Expected status");
	expect(deployment.clawdi_cloud_environments).toBeUndefined();
	expect(deploymentRuntimeUiIsReady(deployment)).toBe(true);
	for (const change of [
		{ summary_state: "updating" as const },
		{ observedGeneration: 0 },
		{ driver_acknowledged_generation: 0 },
		{ driver_applied_generation: 0 },
		{ observed_at: null },
		{ conditions: [] },
		{ conditions: status.conditions.map((condition) => ({ ...condition, observedGeneration: 0 })) },
	]) {
		expect(
			deploymentRuntimeUiIsReady({
				...deployment,
				resource: { ...deployment.resource, status: { ...status, ...change } },
			}),
		).toBe(false);
	}
	expect(deploymentRuntimeUiIsReady({ ...deployment, runtime_ui_endpoint: null })).toBe(false);
	expect(
		deploymentRuntimeUiIsReady({
			...deployment,
			resource: {
				...deployment.resource,
				metadata: { ...deployment.resource.metadata, generation: 2 },
			},
		}),
	).toBe(false);
});

test("running without UI publication retains bounded fast polling until ready", () => {
	const deployment = readyDeployment();
	const pending = { ...deployment, runtime_ui_endpoint: null };
	const first = deploymentPollingState([pending], new Map(), 0);
	expect(first.refetchInterval).toBe(DEPLOYMENT_TRANSITIONAL_POLL_INTERVAL_MS);
	expect(
		deploymentPollingState([pending], first.trackers, DEPLOYMENT_TRANSITION_TIMEOUT_MS)
			.refetchInterval,
	).toBe(DEPLOYMENT_RECONCILIATION_POLL_INTERVAL_MS);
	expect(deploymentPollingState([deployment], first.trackers, 1000).refetchInterval).toBe(
		DEPLOYMENT_RECONCILIATION_POLL_INTERVAL_MS,
	);
});
