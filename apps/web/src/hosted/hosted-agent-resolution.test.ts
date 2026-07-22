import { describe, expect, test } from "bun:test";
import type { HostedDeploymentStatus } from "@/hosted/billing/contracts";
import { BillingApiError, BillingNetworkError } from "@/hosted/billing/errors";
import {
	canOpenHostedRuntimeUi,
	hostedDeploymentMembers,
	missingProjectionRefetchInterval,
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

		expect(result.status).toBe("error");
		expect(result.hasSnapshot).toBe(true);
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
		expect(missingProjectionRefetchInterval(notFound, "running", 1)).toBe(5_000);
		expect(missingProjectionRefetchInterval(notFound, "starting", 3)).toBe(20_000);
		expect(missingProjectionRefetchInterval(notFound, "running", 99)).toBe(60_000);
		expect(missingProjectionRefetchInterval(notFound, "stopped", 1)).toBe(false);
		expect(missingProjectionRefetchInterval(new ApiError(500, "failure"), "running", 1)).toBe(
			false,
		);
	});

	test("gates every Runtime UI entry point on deployment running status", () => {
		expect(canOpenHostedRuntimeUi("running", "https://runtime.example/ui")).toBe(true);
		expect(canOpenHostedRuntimeUi("ready", "https://runtime.example/ui")).toBe(true);
		expect(canOpenHostedRuntimeUi("stopped", "https://runtime.example/ui")).toBe(false);
		expect(canOpenHostedRuntimeUi("failed", "https://runtime.example/ui")).toBe(false);
		expect(canOpenHostedRuntimeUi("running", null)).toBe(false);
	});
});
