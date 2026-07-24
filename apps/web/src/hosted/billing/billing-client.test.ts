import { describe, expect, it } from "bun:test";
import { createBillingClient, unwrapDeploy } from "@/hosted/billing/billing-client";
import { hostedApiBaseUrl } from "@/hosted/billing/billing-url";
import type { DeploymentOperation } from "@/hosted/billing/contracts";
import {
	BillingApiError,
	DEPLOYMENT_CONFLICT_MESSAGE,
	DeploymentConflictError,
} from "@/hosted/billing/errors";
import { hostedDeploymentFixture } from "@/hosted/hosted-deployment.test-fixture";

const NOW = "2026-07-22T00:00:00Z";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function operation({
	done = true,
	id = "op-test",
	verb = "update",
}: {
	done?: boolean;
	id?: string;
	verb?: DeploymentOperation["metadata"]["verb"];
} = {}): DeploymentOperation {
	const deployment = hostedDeploymentFixture({ id: "hdep_test" }).resource;
	return {
		name: `operations/${id}`,
		metadata: {
			"@type": "type.googleapis.com/clawdi.v2.DeploymentOperationMetadata",
			deploymentId: deployment.id,
			verb,
			targetGeneration: 2,
			manifestETag: "manifest-test",
			createTime: NOW,
			updateTime: NOW,
		},
		done,
		response: done
			? {
					"@type": "type.googleapis.com/clawdi.v2.DeploymentOperationResponse",
					deployment,
				}
			: null,
	};
}

function testClient(fetch: (request: Request) => Promise<Response>) {
	return createBillingClient(async () => "test-token", {
		fetch,
		operationPollLimit: 4,
		sleep: async () => undefined,
	});
}

describe("hostedApiBaseUrl", () => {
	it("normalizes a deploy API origin for shared routes", () => {
		expect(hostedApiBaseUrl("https://deploy.example.com/")).toBe("https://deploy.example.com");
	});

	it("strips an existing v2 suffix for shared routes", () => {
		expect(hostedApiBaseUrl("https://deploy.example.com/backend/v2/")).toBe(
			"https://deploy.example.com/backend",
		);
	});
});

describe("unwrapDeploy", () => {
	it("throws on parsed API errors", () => {
		expect(() =>
			unwrapDeploy({
				error: { detail: "insufficient_balance" },
				response: new Response(JSON.stringify({ detail: "insufficient_balance" }), {
					status: 403,
					statusText: "Forbidden",
				}),
			}),
		).toThrow(BillingApiError);
	});

	it("throws on empty-bodied non-2xx responses", () => {
		expect(() =>
			unwrapDeploy({
				response: new Response(null, { status: 503, statusText: "Service Unavailable" }),
			}),
		).toThrow("Billing API 503: Service Unavailable");
	});
});

describe("managed model catalog", () => {
	it("fetches the authenticated v2 managed-model endpoint", async () => {
		const requests: Request[] = [];
		const client = testClient(async (request) => {
			requests.push(request.clone());
			return jsonResponse({
				models: [{ id: "gpt-5.6-luna", display_name: "Luna", is_default: true }],
			});
		});

		await expect(client.getManagedModelCatalog()).resolves.toEqual({
			models: [{ id: "gpt-5.6-luna", display_name: "Luna", is_default: true }],
		});
		expect(new URL(requests[0]?.url ?? "https://invalid").pathname).toBe(
			"/v2/ai-providers/managed/models",
		);
		expect(requests[0]?.headers.get("Authorization")).toBe("Bearer test-token");
	});
});

describe("declarative deployment mutations", () => {
	it("creates an included Basic deployment with an idempotency key and waits for its LRO", async () => {
		const requests: Request[] = [];
		const client = testClient(async (request) => {
			requests.push(request.clone());
			const path = new URL(request.url).pathname;
			if (path === "/v2/deployments" && request.method === "POST") {
				return jsonResponse(operation({ id: "included-create", verb: "create" }), 202);
			}
			throw new Error(`Unexpected request: ${request.method} ${path}`);
		});

		const result = await client.createDeployment(
			{
				compute_plan_slug: "compute_basic",
				runtime: "openclaw",
				ai_provider_auth_kind: "managed",
			},
			"intent-included-create",
		);

		expect(result.deploymentId).toBe("hdep_test");
		expect(requests).toHaveLength(1);
		expect(requests[0]?.headers.get("Idempotency-Key")).toBe("intent-included-create");
		expect(await requests[0]?.json()).toMatchObject({
			compute_plan_slug: "compute_basic",
			runtime: "openclaw",
		});
	});

	it("creates a wallet-funded deployment and waits for its LRO", async () => {
		const requests: Request[] = [];
		const intentKey = "subscription-wallet-deploy-create-happy";
		const client = testClient(async (request) => {
			requests.push(request.clone());
			const path = new URL(request.url).pathname;
			if (path === "/v2/subscription/checkout") {
				return jsonResponse({
					flow_type: "subscription_activation",
					funding_source: "wallet",
					checkout_url: "",
					deploy_request_id: intentKey,
				});
			}
			if (path === `/v2/deployments/by-request/${intentKey}`) {
				return jsonResponse({
					deploy_request_id: intentKey,
					request_status: "processing",
					lineage_tail: {
						deployment_id: "hdep_test",
						lineage_version: 1,
						lineage_state: "processing",
						operation: operation({ done: false, id: "create-happy", verb: "create" }),
					},
				});
			}
			if (path === "/v2/operations/create-happy") {
				return jsonResponse(operation({ id: "create-happy", verb: "create" }));
			}
			throw new Error(`Unexpected request: ${request.method} ${path}`);
		});

		const checkout = await client.checkout(
			{
				plan_slug: "compute_basic",
				billing_term_months: 1,
				funding_source: "wallet",
				ui_mode: "custom",
				deploy_config: {
					compute_plan_slug: "compute_basic",
					runtime: "hermes",
					ai_provider_auth_kind: "managed",
					deploy_request_id: intentKey,
				},
			},
			intentKey,
		);
		expect(checkout.deploy_request_id).toBe(intentKey);
		expect(await client.waitForDeploymentRequest(intentKey)).toMatchObject({
			deploymentId: "hdep_test",
			operation: { done: true, name: "operations/create-happy" },
		});

		const checkoutRequest = requests[0];
		expect(checkoutRequest?.headers.get("Idempotency-Key")).toBe(intentKey);
		expect(await checkoutRequest?.json()).toMatchObject({
			deploy_config: { deploy_request_id: intentKey },
		});
		expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
			"/v2/subscription/checkout",
			`/v2/deployments/by-request/${intentKey}`,
			"/v2/operations/create-happy",
		]);
	});

	it("refetches once and retries a stale If-Match with the same intent key", async () => {
		const mutationHeaders: Headers[] = [];
		let reads = 0;
		const client = testClient(async (request) => {
			const path = new URL(request.url).pathname;
			if (path === "/v2/deployments/hdep_retry" && request.method === "GET") {
				reads += 1;
				return jsonResponse(
					hostedDeploymentFixture({
						id: "hdep_retry",
						resourceVersion: reads === 1 ? "rv-stale" : "rv-fresh",
					}),
				);
			}
			if (path === "/v2/deployments/hdep_retry/stop") {
				mutationHeaders.push(new Headers(request.headers));
				return mutationHeaders.length === 1
					? jsonResponse({ code: "resource_version_mismatch" }, 412)
					: jsonResponse(operation({ id: "stop-retry", verb: "stop" }), 202);
			}
			throw new Error(`Unexpected request: ${request.method} ${path}`);
		});

		await client.setDeploymentDesiredState("hdep_retry", "stopped", "intent-stop-1");

		expect(reads).toBe(2);
		expect(mutationHeaders.map((headers) => headers.get("Idempotency-Key"))).toEqual([
			"intent-stop-1",
			"intent-stop-1",
		]);
		expect(mutationHeaders.map((headers) => headers.get("If-Match"))).toEqual([
			'"rv-stale"',
			'"rv-fresh"',
		]);
	});

	it("surfaces a friendly conflict after the one allowed retry", async () => {
		const client = testClient(async (request) => {
			const path = new URL(request.url).pathname;
			if (path === "/v2/deployments/hdep_conflict" && request.method === "GET") {
				return jsonResponse(
					hostedDeploymentFixture({ id: "hdep_conflict", resourceVersion: "rv-current" }),
				);
			}
			if (path === "/v2/deployments/hdep_conflict/restart") {
				return jsonResponse({ code: "resource_version_mismatch" }, 409);
			}
			throw new Error(`Unexpected request: ${request.method} ${path}`);
		});

		const result = client.restartDeployment("hdep_conflict", "intent-restart-conflict");
		await expect(result).rejects.toBeInstanceOf(DeploymentConflictError);
		await expect(result).rejects.toThrow(DEPLOYMENT_CONFLICT_MESSAGE);
	});

	it("always sends the required headers on every declarative mutation", async () => {
		const mutations: Request[] = [];
		const client = testClient(async (request) => {
			const path = new URL(request.url).pathname;
			if (request.method === "GET" && path.startsWith("/v2/deployments/")) {
				const id = path.slice("/v2/deployments/".length);
				return jsonResponse(hostedDeploymentFixture({ id, resourceVersion: `rv-${id}` }));
			}
			mutations.push(request.clone());
			const verb = path.endsWith("/restart")
				? "restart"
				: path.endsWith("/start")
					? "start"
					: path.endsWith("/stop")
						? "stop"
						: request.method === "DELETE"
							? "delete"
							: "update";
			return jsonResponse(operation({ id: `headers-${verb}`, verb }), 202);
		});

		await client.setDeploymentDesiredState("hdep_start", "running", "intent-start");
		await client.setDeploymentDesiredState("hdep_stop", "stopped", "intent-stop");
		await client.restartDeployment("hdep_restart", "intent-restart");
		await client.updateDeployment("hdep_update", { name: "Renamed" }, "intent-update");
		await client.deleteDeployment("hdep_delete", "intent-delete");

		expect(mutations).toHaveLength(5);
		for (const request of mutations) {
			expect(request.headers.get("Idempotency-Key")).toMatch(/^intent-/);
			expect(request.headers.get("If-Match")).toMatch(/^"rv-hdep_[a-z]+"$/);
		}
	});
});
