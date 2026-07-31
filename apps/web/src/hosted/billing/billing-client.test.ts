import { describe, expect, it } from "bun:test";
import {
	acceptDeclarativeOperation,
	createBillingClient,
	unwrapDeploy,
} from "@/hosted/billing/billing-client";
import { hostedApiBaseUrl } from "@/hosted/billing/billing-url";
import type { DeploymentOperation } from "@/hosted/billing/contracts";
import {
	BillingApiError,
	DEPLOYMENT_CONFLICT_MESSAGE,
	DeploymentConflictError,
	DeploymentRequestTerminalError,
	PlanChangePendingError,
	PlanChangeTerminalError,
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
	deploymentId = "hdep_test",
	id = "op-test",
	verb = "update",
}: {
	done?: boolean;
	deploymentId?: string;
	id?: string;
	verb?: DeploymentOperation["metadata"]["verb"];
} = {}): DeploymentOperation {
	const deployment = hostedDeploymentFixture({ id: "hdep_test" }).resource;
	return {
		name: `operations/${id}`,
		metadata: {
			"@type": "type.googleapis.com/clawdi.v2.DeploymentOperationMetadata",
			deploymentId,
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

function planChangeOperation(
	state: string,
	{ done = false, error = null }: { done?: boolean; error?: unknown } = {},
) {
	return {
		name: "operations/plan-change-1",
		metadata: {
			"@type": "type.googleapis.com/clawdi.v2.DeploymentOperationMetadata",
			deploymentId: "hdep_test",
			verb: "plan_change",
			targetGeneration: 2,
			manifestETag: "manifest-test",
			createTime: NOW,
			updateTime: NOW,
			planChange: {
				"@type": "type.googleapis.com/clawdi.v2.ComputePlanChangeProgress",
				operationId: "plan-change-1",
				subscriptionId: 42,
				fundingSource: "wallet",
				sourcePlanSlug: "compute_basic",
				targetPlanSlug: "compute_performance",
				targetBillingTermMonths: 1,
				state,
				effectiveAt: NOW,
			},
		},
		done,
		error,
		response: null,
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
				models: [
					{
						id: "gpt-5.6-luna",
						display_name: "GPT-5.6-Luna",
						is_default: true,
						is_featured: true,
						summary: "High-volume Codex work",
						cost_hint: "Low cost",
						capabilities: {
							context_window: 272_000,
							max_context_window: null,
							max_input_tokens: 272_000,
							max_output_tokens: 128_000,
							input_modalities: ["text", "image"],
							supports_vision: true,
							supports_reasoning: true,
							supports_tools: true,
						},
					},
				],
			});
		});

		await expect(client.getManagedModelCatalog()).resolves.toEqual({
			models: [
				{
					id: "gpt-5.6-luna",
					display_name: "GPT-5.6-Luna",
					is_default: true,
					is_featured: true,
					summary: "High-volume Codex work",
					cost_hint: "Low cost",
					capabilities: {
						context_window: 272_000,
						max_context_window: null,
						max_input_tokens: 272_000,
						max_output_tokens: 128_000,
						input_modalities: ["text", "image"],
						supports_vision: true,
						supports_reasoning: true,
						supports_tools: true,
					},
				},
			],
		});
		expect(new URL(requests[0]?.url ?? "https://invalid").pathname).toBe(
			"/v2/ai-providers/managed/models",
		);
		expect(requests[0]?.headers.get("Authorization")).toBe("Bearer test-token");
	});
});

describe("declarative deployment mutations", () => {
	it("releases an included Basic deployment as soon as its LRO is accepted", async () => {
		const requests: Request[] = [];
		const client = testClient(async (request) => {
			requests.push(request.clone());
			const path = new URL(request.url).pathname;
			if (path === "/v2/deployments" && request.method === "POST") {
				return jsonResponse(operation({ done: false, id: "included-create", verb: "create" }), 202);
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
		expect(result.operation.done).toBe(false);
		expect(requests).toHaveLength(1);
		expect(requests[0]?.headers.get("Idempotency-Key")).toBe("intent-included-create");
		expect(await requests[0]?.json()).toMatchObject({
			compute_plan_slug: "compute_basic",
			runtime: "openclaw",
		});
		expect(() =>
			acceptDeclarativeOperation({ operation: operation({ done: false, deploymentId: "" }) }),
		).toThrow("The agent service completed creation without returning the agent.");
	});

	it("releases a checkout deployment request as soon as its LRO is accepted", async () => {
		const requests: Request[] = [];
		const intentKey = "subscription-checkout-deploy-create-happy";
		let requestStatusReads = 0;
		const client = testClient(async (request) => {
			requests.push(request.clone());
			const path = new URL(request.url).pathname;
			if (path === "/v2/subscription/checkout") {
				return jsonResponse({
					flow_type: "checkout_session",
					funding_source: "stripe",
					action_url: "https://checkout.example.com/session",
					checkout_url: "https://checkout.example.com/session",
					client_secret: null,
					subscription_id: null,
					invoice_id: null,
					deployment_id: null,
					deployment_name: null,
					metadata_generation: null,
					deploy_request_id: null,
					debited_usd: null,
					balance_after_usd: null,
					current_period_start: null,
					current_period_end: null,
					entitled_until: null,
				});
			}
			if (path === `/v2/deployments/by-request/${intentKey}`) {
				requestStatusReads += 1;
				if (requestStatusReads === 1) {
					return jsonResponse({
						deploy_request_id: intentKey,
						request_status: "ready",
						lineage_tail: {
							deployment_id: "hdep_test",
							lineage_version: 1,
							lineage_state: "unaccepted",
							operation: null,
						},
					});
				}
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
			if (path.startsWith("/v2/operations/")) {
				throw new Error("Accepted checkout deploys must not poll their operation");
			}
			throw new Error(`Unexpected request: ${request.method} ${path}`);
		});

		const checkout = await client.checkout(
			{
				plan_slug: "compute_basic",
				billing_term_months: 1,
				funding_source: "stripe",
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
		expect(checkout.flow_type).toBe("checkout_session");
		expect(checkout.checkout_url).toBe("https://checkout.example.com/session");
		expect(await client.waitForDeploymentRequest(intentKey)).toMatchObject({
			deploymentId: "hdep_test",
			operation: { done: false, name: "operations/create-happy" },
		});

		const checkoutRequest = requests[0];
		expect(checkoutRequest?.headers.get("Idempotency-Key")).toBe(intentKey);
		expect(await checkoutRequest?.json()).toMatchObject({
			deploy_config: { deploy_request_id: intentKey },
		});
		expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
			"/v2/subscription/checkout",
			`/v2/deployments/by-request/${intentKey}`,
			`/v2/deployments/by-request/${intentKey}`,
		]);
	});

	it("surfaces a checkout deployment request that fails before acceptance", async () => {
		const intentKey = "subscription-checkout-deploy-create-failed";
		const requests: Request[] = [];
		const client = testClient(async (request) => {
			requests.push(request.clone());
			const path = new URL(request.url).pathname;
			if (path === `/v2/deployments/by-request/${intentKey}`) {
				return jsonResponse({
					deploy_request_id: intentKey,
					request_status: "failed",
					lineage_tail: {
						deployment_id: null,
						lineage_version: 1,
						lineage_state: "failed",
						operation: null,
					},
				});
			}
			throw new Error(`Unexpected request: ${request.method} ${path}`);
		});

		await expect(client.waitForDeploymentRequest(intentKey)).rejects.toBeInstanceOf(
			DeploymentRequestTerminalError,
		);
		expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
			`/v2/deployments/by-request/${intentKey}`,
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

	it("reveals Runtime UI credentials against the displayed resource version", async () => {
		const requests: Request[] = [];
		const deployment = hostedDeploymentFixture({
			id: "hdep_runtime_ui",
			resourceVersion: "rv-runtime-ui",
		});
		const client = testClient(async (nextRequest) => {
			requests.push(nextRequest.clone());
			return jsonResponse({
				runtime: "openclaw",
				auth_mode: "openclaw_token",
				url: "https://runtime.example/openclaw/",
				deployment_resource_version: "rv-runtime-ui",
				token: "gateway-token",
				handoff_url: "https://runtime.example/openclaw/#token=gateway-token",
			});
		});

		await client.getRuntimeUiCredentials(
			deployment.resource.id,
			deployment.resource.metadata.resourceVersion,
		);

		const request = requests[0];
		expect(request ? new URL(request.url).pathname : null).toBe(
			"/v2/deployments/hdep_runtime_ui/runtime-ui/credentials",
		);
		expect(request?.headers.get("If-Match")).toBe('"rv-runtime-ui"');
		expect(request?.headers.get("Idempotency-Key")).toBeNull();
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
			const verb = path.endsWith("/runtime-ui/access/reset")
				? "reset_runtime_ui_access"
				: path.endsWith("/restart")
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
		await client.resetRuntimeUiAccess("hdep_access", "intent-access-reset");
		await client.updateDeployment("hdep_update", { name: "Renamed" }, "intent-update");
		await client.deleteDeployment(
			"hdep_delete",
			{ subscription_choice: "keep_subscription" },
			"intent-delete",
		);

		expect(mutations).toHaveLength(6);
		for (const request of mutations) {
			expect(request.headers.get("Idempotency-Key")).toMatch(/^intent-/);
			expect(request.headers.get("If-Match")).toMatch(/^"rv-hdep_[a-z]+"$/);
		}
		const deleteRequests = mutations.filter((request) => request.method === "DELETE");
		expect(deleteRequests).toHaveLength(1);
		expect(await deleteRequests[0]?.json()).toEqual({
			subscription_choice: "keep_subscription",
		});
	});

	it("releases lifecycle and settings mutations as soon as their LROs are accepted", async () => {
		const requests: Request[] = [];
		const client = testClient(async (request) => {
			requests.push(request.clone());
			const path = new URL(request.url).pathname;
			if (request.method === "GET" && path.startsWith("/v2/deployments/")) {
				const id = path.slice("/v2/deployments/".length);
				return jsonResponse(hostedDeploymentFixture({ id, resourceVersion: `rv-${id}` }));
			}
			if (path.startsWith("/v2/operations/")) {
				throw new Error("Accepted declarative mutations must not poll their operations");
			}
			const verb = path.endsWith("/runtime-ui/access/reset")
				? "reset_runtime_ui_access"
				: path.endsWith("/restart")
					? "restart"
					: path.endsWith("/start")
						? "start"
						: path.endsWith("/stop")
							? "stop"
							: request.method === "DELETE"
								? "delete"
								: "update";
			return jsonResponse(operation({ done: false, id: `accepted-${verb}`, verb }), 202);
		});

		const accepted = await Promise.all([
			client.setDeploymentDesiredState("hdep_start", "running", "intent-start"),
			client.setDeploymentDesiredState("hdep_stop", "stopped", "intent-stop"),
			client.restartDeployment("hdep_restart", "intent-restart"),
			client.resetRuntimeUiAccess("hdep_access", "intent-access-reset"),
			client.updateDeployment(
				"hdep_provider",
				{
					ai_provider_auth_kind: "managed",
					provider_ids: ["managed"],
					primary_model: { provider_id: "managed", model: "gpt-5.6-luna" },
				},
				"intent-provider",
			),
			client.updateDeployment(
				"hdep_locale",
				{ language: "fr", timezone: "Europe/Paris" },
				"intent-locale",
			),
			client.deleteDeployment(
				"hdep_delete",
				{ subscription_choice: "cancel_subscription" },
				"intent-delete",
			),
		]);

		expect(
			accepted.every((item) => !item.operation.done && item.deploymentId === "hdep_test"),
		).toBe(true);
		expect(
			requests.filter((request) => new URL(request.url).pathname.startsWith("/v2/operations/")),
		).toHaveLength(0);
	});

	it("keeps an accepted delete visible when reconciliation later fails", async () => {
		const failure = {
			type: "https://api.clawdi.ai/problems/deployment-delete-failed",
			title: "Deployment deletion failed",
			status: 409,
			detail: "The deployment could not be deleted.",
			instance: "hdep_delete_failure",
			code: "deployment_delete_failed",
			conditionReason: "DeploymentDeleteFailed",
			conditionMessage: "The deployment could not be deleted.",
			observedGeneration: 2,
		};
		const failedDeployment = hostedDeploymentFixture({
			id: "hdep_delete_failure",
			status: "failed",
			failure,
		});
		const client = testClient(async (request) => {
			const path = new URL(request.url).pathname;
			if (path === "/v2/deployments/hdep_delete_failure" && request.method === "GET") {
				return jsonResponse(hostedDeploymentFixture({ id: "hdep_delete_failure" }));
			}
			if (path === "/v2/deployments/hdep_delete_failure" && request.method === "DELETE") {
				return jsonResponse(operation({ done: false, id: "delete-failure", verb: "delete" }), 202);
			}
			if (path === "/v2/deployments" && request.method === "GET") {
				return jsonResponse([failedDeployment]);
			}
			throw new Error(`Unexpected request: ${request.method} ${path}`);
		});

		await expect(
			client.deleteDeployment(
				"hdep_delete_failure",
				{ subscription_choice: "cancel_subscription" },
				"intent-delete-failure",
			),
		).resolves.toMatchObject({
			deploymentId: "hdep_test",
			operation: { done: false, name: "operations/delete-failure" },
		});
		await expect(client.listDeployments()).resolves.toMatchObject([
			{
				resource: {
					id: "hdep_delete_failure",
					status: { summary_state: "failed", failure },
				},
			},
		]);
	});
});

describe("compute plan changes", () => {
	it("accepts once and waits through awaiting_payment for terminal success", async () => {
		const requests: Request[] = [];
		const acceptedOperations: string[] = [];
		const responses = [
			planChangeOperation("quoted"),
			planChangeOperation("awaiting_payment"),
			planChangeOperation("complete", { done: true }),
		];
		const client = testClient(async (request) => {
			requests.push(request.clone());
			if (request.method === "GET") {
				expect(acceptedOperations).toEqual(["operations/plan-change-1"]);
			}
			const response = responses.shift();
			if (!response) throw new Error("Unexpected plan-change request");
			return jsonResponse(response, request.method === "POST" ? 202 : 200);
		});

		await expect(
			client.changePlan({ operation_id: "plan-change-1" }, (operationName) => {
				acceptedOperations.push(operationName);
			}),
		).resolves.toEqual({
			kind: "complete",
			effectiveAt: NOW,
		});
		expect(acceptedOperations).toEqual(["operations/plan-change-1"]);
		expect(requests.map((request) => request.method)).toEqual(["POST", "GET", "GET"]);
		expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
			"/v2/subscription/plan/change",
			"/v2/operations/plan-change-1",
			"/v2/operations/plan-change-1",
		]);
		expect(requests[0]?.headers.get("Idempotency-Key")).toBe("plan-change-1");
	});

	it("offers a GET-only status check after bounded polling", async () => {
		const requests: Request[] = [];
		let complete = false;
		const client = testClient(async (request) => {
			requests.push(request.clone());
			if (request.method === "POST") return jsonResponse(planChangeOperation("quoted"), 202);
			return jsonResponse(
				complete
					? planChangeOperation("complete", { done: true })
					: planChangeOperation("awaiting_projection"),
			);
		});

		let pending: unknown;
		try {
			await client.changePlan({ operation_id: "plan-change-1" });
		} catch (error) {
			pending = error;
		}
		expect(pending).toBeInstanceOf(PlanChangePendingError);
		if (!(pending instanceof PlanChangePendingError)) throw pending;
		expect(requests.filter((request) => request.method === "POST")).toHaveLength(1);

		requests.length = 0;
		await expect(client.checkPlanChange(pending.operationName)).rejects.toBeInstanceOf(
			PlanChangePendingError,
		);
		expect(requests.map((request) => request.method)).toEqual(["GET"]);

		requests.length = 0;
		complete = true;
		await expect(client.checkPlanChange(pending.operationName)).resolves.toEqual({
			kind: "complete",
			effectiveAt: NOW,
		});
		expect(requests.map((request) => request.method)).toEqual(["GET"]);
	});

	it("surfaces a terminal operation failure instead of reporting success", async () => {
		const accepted = planChangeOperation("awaiting_payment");
		const failed = planChangeOperation("failed", {
			done: true,
			error: {
				code: 9,
				message: "Plan change failed",
				details: [
					{
						"@type": "type.googleapis.com/clawdi.v2.LifecycleProblemDetails",
						type: "https://api.clawdi.ai/problems/operation_aborted",
						title: "Plan change failed",
						status: 409,
						detail: "The payment method was rejected. Update it and request a new price.",
						instance: "operations/plan-change-1",
						code: "operation_aborted",
						phase: "plan_change",
						retryable: false,
						conditionReason: "OperationAborted",
						conditionMessage: "Plan change failed",
						observedGeneration: 2,
					},
				],
			},
		});
		const responses = [accepted, failed];
		const client = testClient(async (request) => {
			const response = responses.shift();
			if (!response) throw new Error(`Unexpected request: ${request.method}`);
			return jsonResponse(response, request.method === "POST" ? 202 : 200);
		});

		const result = client.changePlan({ operation_id: "plan-change-1" });
		await expect(result).rejects.toBeInstanceOf(PlanChangeTerminalError);
		await expect(result).rejects.toThrow("The payment method was rejected");
	});
});
