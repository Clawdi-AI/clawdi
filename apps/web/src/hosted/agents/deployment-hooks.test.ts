import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { QueryClient } from "@tanstack/react-query";
import { billingKeys } from "@/hosted/billing/query-keys";
import { hostedDeploymentFixture } from "@/hosted/hosted-deployment.test-fixture";

type InvalidateDeploymentSnapshots =
	typeof import("@/hosted/agents/deployment-hooks").invalidateDeploymentSnapshots;
type RuntimeUiSettlingPollState =
	typeof import("@/hosted/agents/deployment-hooks").runtimeUiSettlingPollState;

let invalidateSnapshots: InvalidateDeploymentSnapshots | null = null;
let settlingPollState: RuntimeUiSettlingPollState | null = null;
let settlingPollIntervalMs: number | null = null;
let settlingTimeoutMs: number | null = null;

beforeAll(async () => {
	process.env.VITE_CLAWDI_API_URL = "http://localhost:8000";
	process.env.VITE_CLAWDI_DEPLOY_API_URL = "http://localhost:50021";
	process.env.VITE_CLERK_PUBLISHABLE_KEY = "pk_test_dummy";
	const module = await import("@/hosted/agents/deployment-hooks");
	invalidateSnapshots = module.invalidateDeploymentSnapshots;
	settlingPollState = module.runtimeUiSettlingPollState;
	settlingPollIntervalMs = module.RUNTIME_UI_SETTLING_POLL_INTERVAL_MS;
	settlingTimeoutMs = module.RUNTIME_UI_SETTLING_TIMEOUT_MS;
});

describe("runtime UI settling polling", () => {
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
					requires_bridge_token: true,
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

		// Declarative lifecycle and delete both reconcile even when the request
		// rejects or times out.
		expect(settlementInvalidations).toHaveLength(2);
	});
});
