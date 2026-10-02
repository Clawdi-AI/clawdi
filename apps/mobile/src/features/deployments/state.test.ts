import { expect, test } from "bun:test";
import type { DeployComponents, HostedDeployOperation } from "@clawdi/shared/api";
import {
	canPollDeployment,
	DEPLOYMENT_POLL_WINDOW_MS,
	deploymentNeedsPolling,
	operationIdFromName,
} from "./state";

test("terminal operation errors stop stale creating status; unknown status still polls", () => {
	const status: DeployComponents["schemas"]["HostedDeploymentStatus"] = {
		summary_state: "creating",
		observedGeneration: 1,
		conditions: [],
		driver_acknowledged_generation: 0,
		driver_applied_generation: 0,
		driver_observation_sequence: 0,
		endpoints: [],
	};
	const operation: HostedDeployOperation = {
		name: "operations/op_123",
		done: true,
		error: { code: 13, message: "Internal details", details: [] },
		metadata: {
			"@type": "type.googleapis.com/clawdi.v2.DeploymentOperationMetadata",
			deploymentId: "hdep_123",
			verb: "create",
			targetGeneration: 1,
			manifestETag: "etag",
			createTime: "2026-10-02T23:00:00Z",
			updateTime: "2026-10-02T23:00:00Z",
		},
	};
	expect(deploymentNeedsPolling({ resource: { status }, accepted_operation: operation })).toBe(
		false,
	);
	expect(
		deploymentNeedsPolling({
			resource: { status },
			accepted_operation: { ...operation, done: false },
		}),
	).toBe(true);
	expect(deploymentNeedsPolling({ resource: { status: null } })).toBe(true);
	expect(
		deploymentNeedsPolling({ resource: { status: { ...status, summary_state: "running" } } }),
	).toBe(false);
});

test("LRO names become one safe operation ID", () => {
	expect(operationIdFromName("operations/op_abc-123")).toBe("op_abc-123");
	for (const name of [
		undefined,
		"op_abc",
		"operations/",
		"operations/a/b",
		"operations/../a",
		"operations/a%2Fb",
		"operations/a?b",
		"operations/a b",
	])
		expect(operationIdFromName(name)).toBeNull();
});

test("polling requires foreground connectivity and expires at the deadline", () => {
	expect(canPollDeployment(100, 101, true, true)).toBe(true);
	expect(canPollDeployment(100, 101, false, true)).toBe(false);
	expect(canPollDeployment(100, 101, true, false)).toBe(false);
	expect(canPollDeployment(100, 100 + DEPLOYMENT_POLL_WINDOW_MS, true, true)).toBe(false);
});
