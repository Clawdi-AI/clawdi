import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { QueryClient } from "@tanstack/react-query";
import type { DeploymentOperation, HostedDeployment } from "@/hosted/billing/contracts";
import { billingKeys } from "@/hosted/billing/query-keys";
import { deploymentFailureReason } from "@/hosted/deployment-failure";
import {
	DEPLOYMENT_TRANSITIONAL_POLL_INTERVAL_MS,
	deploymentRefetchInterval,
} from "@/hosted/deployment-status";
import { hostedDeploymentFixture } from "@/hosted/hosted-deployment.test-fixture";

type InvalidateDeploymentSnapshots =
	typeof import("@/hosted/agents/deployment-hooks").invalidateDeploymentSnapshots;
type ProjectAcceptedDeploymentTransition =
	typeof import("@/hosted/agents/deployment-hooks").projectAcceptedDeploymentTransition;
type RuntimeUiSettlingPollState =
	typeof import("@/hosted/agents/deployment-hooks").runtimeUiSettlingPollState;

let invalidateSnapshots: InvalidateDeploymentSnapshots | null = null;
let projectAcceptedTransition: ProjectAcceptedDeploymentTransition | null = null;
let settlingPollState: RuntimeUiSettlingPollState | null = null;
let settlingPollIntervalMs: number | null = null;
let settlingTimeoutMs: number | null = null;

beforeAll(async () => {
	process.env.VITE_CLAWDI_API_URL = "http://localhost:8000";
	process.env.VITE_CLAWDI_DEPLOY_API_URL = "http://localhost:50021";
	process.env.VITE_CLERK_PUBLISHABLE_KEY = "pk_test_dummy";
	const module = await import("@/hosted/agents/deployment-hooks");
	invalidateSnapshots = module.invalidateDeploymentSnapshots;
	projectAcceptedTransition = module.projectAcceptedDeploymentTransition;
	settlingPollState = module.runtimeUiSettlingPollState;
	settlingPollIntervalMs = module.RUNTIME_UI_SETTLING_POLL_INTERVAL_MS;
	settlingTimeoutMs = module.RUNTIME_UI_SETTLING_TIMEOUT_MS;
});

describe("runtime UI settling polling", () => {
	test("derives the same pending tracker across repeated render-phase calculations", () => {
		if (!settlingPollState) throw new Error("deployment hooks were not loaded");
		const nowMs = Date.parse("2026-07-23T12:00:00Z");
		const deployment = hostedDeploymentFixture({ status: "running", runtime: "hermes" });
		const committedTracker = null;

		const firstRender = settlingPollState(deployment, "hermes", committedTracker, nowMs);
		const repeatedRender = settlingPollState(deployment, "hermes", committedTracker, nowMs);

		expect(repeatedRender).toEqual(firstRender);
		expect(committedTracker).toBeNull();
	});

	test("commits the derived tracker only from an effect", () => {
		const source = readFileSync(new URL("./deployment-hooks.ts", import.meta.url), "utf8");
		const hookStart = source.indexOf("export function useAgentDeployment");
		const hookEnd = source.indexOf("export type {", hookStart);
		const hookSource = source.slice(hookStart, hookEnd);
		const assignments = hookSource.match(/runtimeUiSettlingTrackerRef\.current\s*=/g) ?? [];

		expect(assignments).toHaveLength(1);
		expect(hookSource).toContain(
			"useEffect(() => {\n\t\truntimeUiSettlingTrackerRef.current = runtimeUiSettling.tracker;",
		);
	});

	test("rapidly polls a running deployment until its selected runtime UI appears", () => {
		if (!settlingPollState || !settlingPollIntervalMs) {
			throw new Error("deployment hooks were not loaded");
		}
		const nowMs = Date.parse("2026-07-23T12:00:00Z");
		const deployment = hostedDeploymentFixture({ status: "running", runtime: "hermes" });
		const pending = settlingPollState(deployment, "hermes", null, nowMs);

		expect(pending.refetchInterval).toBe(settlingPollIntervalMs);
		expect(pending.timedOut).toBe(false);
		expect(pending.tracker?.startedAtMs).toBe(nowMs);

		const ready = settlingPollState(
			hostedDeploymentFixture({
				status: "running",
				runtime: "hermes",
				runtimeUiEndpoint: {
					runtime: "hermes",
					role: "control_ui",
					url: "https://runtime.example/hermes",
					auth_mode: "password",
					browser_mode: "top_level",
				},
			}),
			"hermes",
			pending.tracker,
			nowMs + settlingPollIntervalMs,
		);
		expect(ready).toEqual({ refetchInterval: false, timedOut: false, tracker: null });
	});

	test("bounds rapid polling to the runtime UI boot window", () => {
		if (!settlingPollState || !settlingTimeoutMs) {
			throw new Error("deployment hooks were not loaded");
		}
		const nowMs = Date.parse("2026-07-23T12:00:00Z");
		const deployment = hostedDeploymentFixture({ status: "running" });
		const pending = settlingPollState(deployment, "openclaw", null, nowMs);
		const timedOut = settlingPollState(
			deployment,
			"openclaw",
			pending.tracker,
			nowMs + settlingTimeoutMs,
		);

		expect(timedOut.refetchInterval).toBe(false);
		expect(timedOut.timedOut).toBe(true);
		expect(timedOut.tracker).toEqual(pending.tracker);
	});

	test("uses an A4 Ready transition to recognize an already-stuck boot", () => {
		if (!settlingPollState || !settlingTimeoutMs) {
			throw new Error("deployment hooks were not loaded");
		}
		const nowMs = Date.parse("2026-07-23T12:00:00Z");
		const deployment = hostedDeploymentFixture({ status: "running" });
		deployment.resource.status.conditions = [
			{
				type: "Ready",
				status: "True",
				observedGeneration: 1,
				lastTransitionTime: new Date(nowMs - settlingTimeoutMs).toISOString(),
				reason: "RuntimeReady",
				message: "Runtime reported ready",
			},
		];

		const state = settlingPollState(deployment, "openclaw", null, nowMs);
		expect(state.refetchInterval).toBe(false);
		expect(state.timedOut).toBe(true);
	});

	test("does not override polling for non-running lifecycle states", () => {
		if (!settlingPollState) throw new Error("deployment hooks were not loaded");
		const state = settlingPollState(
			hostedDeploymentFixture({ status: "starting" }),
			"openclaw",
			null,
			Date.now(),
		);
		expect(state).toEqual({ refetchInterval: false, timedOut: false, tracker: null });
	});
});

function acceptedOperation(verb: DeploymentOperation["metadata"]["verb"]): DeploymentOperation {
	return {
		name: `operations/${verb}-accepted`,
		metadata: {
			"@type": "type.googleapis.com/clawdi.v2.DeploymentOperationMetadata",
			deploymentId: "hdep_test",
			verb,
			targetGeneration: 2,
			manifestETag: "manifest-accepted",
			createTime: "2026-07-24T00:00:00Z",
			updateTime: "2026-07-24T00:00:00Z",
		},
		done: false,
		response: null,
	};
}

describe("deployment mutation settlement", () => {
	test("invalidates deployment membership and its additive agent projection together", () => {
		const queryClient = new QueryClient();
		queryClient.setQueryData(billingKeys.deployments, []);
		queryClient.setQueryData(["agents"], []);

		if (!invalidateSnapshots) throw new Error("deployment hooks were not loaded");
		invalidateSnapshots(queryClient);

		expect(queryClient.getQueryState(billingKeys.deployments)?.isInvalidated).toBe(true);
		expect(queryClient.getQueryState(["agents"])?.isInvalidated).toBe(true);
	});

	test("uses the shared invalidation on every inventory-changing mutation settlement", () => {
		const source = readFileSync(new URL("./deployment-hooks.ts", import.meta.url), "utf8");
		const settlementInvalidations = source.match(
			/onSettled: \(\) => invalidateDeploymentSnapshots\(qc\)/g,
		);

		// Declarative lifecycle, delete, and settings updates all reconcile even
		// when the request rejects or times out.
		expect(settlementInvalidations).toHaveLength(3);
	});

	test("projects every accepted operation through the shared transition model", () => {
		if (!projectAcceptedTransition) throw new Error("deployment hooks were not loaded");
		const queryClient = new QueryClient();
		queryClient.setQueryData<HostedDeployment[]>(billingKeys.deployments, [
			hostedDeploymentFixture({ id: "hdep_test" }),
		]);
		const expectations = [
			["create", "creating"],
			["start", "starting"],
			["stop", "stopping"],
			["restart", "restarting"],
			["update", "updating"],
			["runtime_switch", "updating"],
			["rename", "updating"],
			["delete", "deleting"],
		] as const;

		for (const [verb, status] of expectations) {
			const operation = acceptedOperation(verb);
			const accepted = { deploymentId: "hdep_test", operation };
			projectAcceptedTransition(queryClient, accepted, () => undefined);
			const deployments = queryClient.getQueryData<HostedDeployment[]>(billingKeys.deployments);

			expect(deployments?.[0]?.resource.status.summary_state).toBe(status);
			expect(deployments?.[0]?.resource.status.failure).toBeNull();
			expect(deployments?.[0]?.accepted_operation).toEqual(operation);
			expect(
				deploymentRefetchInterval(deployments, new Map(), Date.parse("2026-07-24T00:00:00Z")),
			).toBe(DEPLOYMENT_TRANSITIONAL_POLL_INTERVAL_MS);
		}
	});

	test("keeps an accepted delete in cache so a later failure can replace it", () => {
		if (!projectAcceptedTransition) throw new Error("deployment hooks were not loaded");
		const queryClient = new QueryClient();
		queryClient.setQueryData<HostedDeployment[]>(billingKeys.deployments, [
			hostedDeploymentFixture({ id: "hdep_delete" }),
		]);
		projectAcceptedTransition(
			queryClient,
			{ deploymentId: "hdep_delete", operation: acceptedOperation("delete") },
			() => undefined,
		);

		const deleting = queryClient.getQueryData<HostedDeployment[]>(billingKeys.deployments);
		expect(deleting).toHaveLength(1);
		expect(deleting?.[0]?.resource.status.summary_state).toBe("deleting");

		const failure = {
			type: "https://api.clawdi.ai/problems/deployment-delete-failed",
			title: "Deployment deletion failed",
			status: 409,
			detail: "The deployment could not be deleted.",
			instance: "hdep_delete",
			code: "deployment_delete_failed",
			conditionReason: "DeploymentDeleteFailed",
			conditionMessage: "The deployment could not be deleted.",
			observedGeneration: 2,
		};
		queryClient.setQueryData<HostedDeployment[]>(billingKeys.deployments, [
			hostedDeploymentFixture({ id: "hdep_delete", status: "failed", failure }),
		]);

		const failed = queryClient.getQueryData<HostedDeployment[]>(billingKeys.deployments);
		expect(failed).toHaveLength(1);
		expect(failed?.[0]?.resource.status.summary_state).toBe("failed");
		expect(deploymentFailureReason(failed?.[0]?.resource.status ?? {})).toBe(
			"Deployment deletion failed",
		);
	});
});
