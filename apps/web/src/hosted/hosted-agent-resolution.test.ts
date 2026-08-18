import { describe, expect, test } from "bun:test";
import type { DeploymentOperation, HostedDeploymentStatus } from "@/hosted/billing/contracts";
import { BillingApiError, BillingNetworkError } from "@/hosted/billing/errors";
import { deploymentStatusFromResource, parseDeploymentStatus } from "@/hosted/deployment-status";
import {
	canOpenHostedRuntimeUi,
	claimedEnvIdsFromDeployments,
	hostedDeploymentMembers,
	isHostedDeploymentVisible,
	missingProjectionRefetchInterval,
	resolveAgentDeployment,
	resolveHostedAgentProjection,
	resolveHostedInventory,
} from "@/hosted/hosted-agent-resolution";
import { hostedDeploymentFixture } from "@/hosted/hosted-deployment.test-fixture";
import { ApiError } from "@/lib/api-errors";

function deployment(
	status: HostedDeploymentStatus["summary_state"] = "running",
	id = `dep_${status}`,
) {
	return hostedDeploymentFixture({
		id,
		name: id,
		status,
		createdAt: "2026-07-16T00:00:00Z",
		endpoints: [{ name: "openclaw", url: "https://runtime.example/ui" }],
	});
}

function acceptedDelete(deploymentId: string): DeploymentOperation {
	return {
		name: `operations/delete-${deploymentId}`,
		metadata: {
			"@type": "type.googleapis.com/clawdi.v2.DeploymentOperationMetadata",
			deploymentId,
			verb: "delete",
			targetGeneration: 2,
			manifestETag: "manifest-delete",
			createTime: "2026-07-27T00:00:00Z",
			updateTime: "2026-07-27T00:00:00Z",
		},
		done: false,
		response: null,
	};
}

function cancelledDelete(deploymentId: string): DeploymentOperation {
	return {
		...acceptedDelete(deploymentId),
		done: true,
		error: {
			code: 1,
			message: "Delete was cancelled before teardown.",
			details: [],
		},
		response: null,
	};
}

describe("hosted inventory resolution matrix", () => {
	test("distinguishes a successful empty snapshot from loading", () => {
		expect(
			resolveHostedInventory({
				enabled: true,
				configured: true,
				data: [],
				error: null,
				isPending: false,
			}),
		).toMatchObject({ status: "resolved", deployments: [], hasSnapshot: true, error: null });

		expect(
			resolveHostedInventory({
				enabled: true,
				configured: true,
				data: undefined,
				error: null,
				isPending: true,
			}),
		).toMatchObject({ status: "loading", deployments: null, hasSnapshot: false, error: null });
	});

	test("keeps 403 and transport failures unresolved instead of inventing an empty list", () => {
		const forbidden = resolveHostedInventory({
			enabled: true,
			configured: true,
			data: undefined,
			error: new BillingApiError(403, "deployment access revoked"),
			isPending: false,
		});
		expect(forbidden).toMatchObject({ status: "error", deployments: null, hasSnapshot: false });

		const offline = resolveHostedInventory({
			enabled: true,
			configured: true,
			data: undefined,
			error: new BillingNetworkError("offline"),
			isPending: false,
		});
		expect(offline).toMatchObject({
			status: "unavailable",
			deployments: null,
			hasSnapshot: false,
		});
	});

	test("retains a last-known snapshot on refresh failure and removes deleted membership", () => {
		const running = deployment("running");
		const deleted = deployment("deleted");
		const result = resolveHostedInventory({
			enabled: true,
			configured: true,
			data: [running, deleted],
			error: new BillingApiError(500, "upstream unavailable"),
			isPending: false,
		});

		expect(result.status).toBe("resolved");
		expect(result.hasSnapshot).toBe(true);
		expect(result.error).toBeNull();
		expect(result.deployments?.map((item) => item.resource.id)).toEqual([running.resource.id]);
		expect(hostedDeploymentMembers([deleted])).toEqual([]);
	});

	test("treats a disabled source as a resolved empty inventory", () => {
		expect(
			resolveHostedInventory({
				enabled: false,
				configured: false,
				data: undefined,
				error: null,
				isPending: true,
			}),
		).toEqual({ status: "resolved", deployments: [], hasSnapshot: true, error: null });
	});
});

describe("hosted detail projection resolution", () => {
	test("suppresses stale detail as soon as delete is accepted without releasing ownership", () => {
		const agentId = "55555555-5555-4555-8555-555555555555";
		const deploymentId = "hdep_user_deleted";
		const deleting = hostedDeploymentFixture({
			id: deploymentId,
			agentId,
			status: "running",
			cloudEnvironments: { openclaw: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
			acceptedOperation: acceptedDelete(deploymentId),
		});

		expect(isHostedDeploymentVisible(deleting)).toBe(false);
		expect(hostedDeploymentMembers([deleting])).toEqual([deleting]);
		expect(claimedEnvIdsFromDeployments([deleting])).toEqual(new Set([agentId]));
		expect(resolveAgentDeployment([deleting], agentId)).toBeNull();
	});

	test("keeps a dismissed agent hidden across a failed snapshot while delete remains pending", () => {
		const deploymentId = "hdep_delete_failed";
		const failed = hostedDeploymentFixture({
			id: deploymentId,
			status: "failed",
			acceptedOperation: acceptedDelete(deploymentId),
		});

		expect(isHostedDeploymentVisible(failed)).toBe(false);
		expect(resolveAgentDeployment([failed], failed.agent_id)).toBeNull();
	});

	test("restores a running agent when its accepted delete is cancelled", () => {
		const deploymentId = "hdep_delete_cancelled";
		const restored = hostedDeploymentFixture({
			id: deploymentId,
			status: "running",
			acceptedOperation: cancelledDelete(deploymentId),
			computeSlotOccupancy: {
				occupies_slot: true,
				backing_infra: "present",
				reason: "backing_infra_present",
			},
		});

		expect(isHostedDeploymentVisible(restored)).toBe(true);
		expect(resolveAgentDeployment([restored], restored.agent_id)?.deployment).toBe(restored);
	});

	test("keeps an agent hidden while occupancy authoritatively reports delete accepted", () => {
		const deploymentId = "hdep_delete_accepted";
		const deleting = hostedDeploymentFixture({
			id: deploymentId,
			status: "running",
			acceptedOperation: null,
			computeSlotOccupancy: {
				occupies_slot: false,
				backing_infra: "present",
				reason: "delete_accepted",
			},
		});

		expect(isHostedDeploymentVisible(deleting)).toBe(false);
		expect(resolveAgentDeployment([deleting], deleting.agent_id)).toBeNull();
	});

	test("resolves stopped deployment authority without a Cloud projection", () => {
		const agentId = "55555555-5555-4555-8555-555555555555";
		const stopped = hostedDeploymentFixture({
			id: "hdep_stopped",
			agentId,
			status: "stopped",
			cloudEnvironments: {},
		});
		const resolution = resolveAgentDeployment([stopped], agentId);

		expect(resolution?.deployment.resource.id).toBe("hdep_stopped");
		expect(resolution?.runtime).toBe("openclaw");
	});

	test("never treats deployment or observed projection ids as Agent identity", () => {
		const agentId = "55555555-5555-4555-8555-555555555555";
		const projectionId = "66666666-6666-4666-8666-666666666666";
		const matched = hostedDeploymentFixture({
			id: "hdep_matched",
			agentId,
			cloudEnvironments: { openclaw: projectionId },
		});

		expect(resolveAgentDeployment([matched], agentId)?.deployment).toBe(matched);
		expect(resolveAgentDeployment([matched], projectionId)).toBeNull();
		expect(resolveAgentDeployment([matched], matched.resource.id)).toBeNull();
	});

	test("keeps missing, service-error, loading, unavailable, and resolved states distinct", () => {
		const notFound = new ApiError(404, "Agent not found");
		const serviceError = new ApiError(500, "gateway failure");
		const agent = { id: "agent_123" };

		expect(
			resolveHostedAgentProjection({
				enabled: true,
				data: undefined,
				error: notFound,
				isPending: false,
			}),
		).toEqual({ status: "missing", data: null, error: notFound });
		expect(
			resolveHostedAgentProjection({
				enabled: true,
				data: agent,
				error: serviceError,
				isPending: false,
			}),
		).toEqual({ status: "error", data: null, error: serviceError });
		expect(
			resolveHostedAgentProjection({
				enabled: true,
				data: undefined,
				error: null,
				isPending: true,
			}),
		).toEqual({ status: "loading", data: null, error: null });
		expect(
			resolveHostedAgentProjection({
				enabled: false,
				data: undefined,
				error: null,
				isPending: true,
			}),
		).toEqual({ status: "unavailable", data: null, error: null });
		expect(
			resolveHostedAgentProjection({ enabled: true, data: agent, error: null, isPending: false }),
		).toEqual({ status: "resolved", data: agent, error: null });
	});

	test("uses capped backoff only while a missing projection can still recover", () => {
		const notFound = new ApiError(404, "Agent not found");
		expect(missingProjectionRefetchInterval(notFound, parseDeploymentStatus("running"), 1)).toBe(
			5_000,
		);
		expect(missingProjectionRefetchInterval(notFound, parseDeploymentStatus("starting"), 3)).toBe(
			20_000,
		);
		expect(missingProjectionRefetchInterval(notFound, parseDeploymentStatus("running"), 99)).toBe(
			60_000,
		);
		expect(missingProjectionRefetchInterval(notFound, parseDeploymentStatus("stopped"), 1)).toBe(
			false,
		);
		expect(
			missingProjectionRefetchInterval(
				new ApiError(500, "failure"),
				parseDeploymentStatus("running"),
				1,
			),
		).toBe(false);
		expect(missingProjectionRefetchInterval(notFound, deploymentStatusFromResource(null), 1)).toBe(
			false,
		);
	});

	test("gates every Runtime UI entry point on deployment running status", () => {
		expect(
			canOpenHostedRuntimeUi(parseDeploymentStatus("running"), "https://runtime.example/ui"),
		).toBe(true);
		expect(
			canOpenHostedRuntimeUi(parseDeploymentStatus("ready"), "https://runtime.example/ui"),
		).toBe(true);
		expect(
			canOpenHostedRuntimeUi(parseDeploymentStatus("stopped"), "https://runtime.example/ui"),
		).toBe(false);
		expect(
			canOpenHostedRuntimeUi(parseDeploymentStatus("failed"), "https://runtime.example/ui"),
		).toBe(false);
		expect(canOpenHostedRuntimeUi(parseDeploymentStatus("running"), null)).toBe(false);
		expect(
			canOpenHostedRuntimeUi(deploymentStatusFromResource(null), "https://runtime.example/ui"),
		).toBe(false);
	});
});
