import { describe, expect, it } from "bun:test";
import {
	acceptDeclarativeOperation,
	createBillingClient,
	retryIdempotentBillingTransport,
	unwrapDeploy,
} from "@/hosted/billing/billing-client";
import { hostedApiBaseUrl } from "@/hosted/billing/billing-url";
import type {
	ComputePlanChangeBillingEffect,
	ComputePlanChangeKind,
	ComputePlanChangeProgress,
	DeploymentOperation,
} from "@/hosted/billing/contracts";
import {
	BillingApiError,
	BillingNetworkError,
	DEPLOYMENT_CONFLICT_MESSAGE,
	DeploymentConflictError,
	PlanChangePendingError,
	PlanChangeTerminalError,
} from "@/hosted/billing/errors";
import { hostedDeploymentFixture } from "@/hosted/hosted-deployment.test-fixture";

const NOW = "2026-07-22T00:00:00Z";

describe("idempotent billing transport", () => {
	it("retries one network failure with the exact request", async () => {
		for (const requestCase of [
			{ path: "/v2/wallet/topup", body: '{"amount_cents":1200}', key: "topup-1" },
			{
				path: "/v2/wallet/auto-reload/setup-intent",
				body: '{"consent_version":"wallet_auto_reload_off_session_v2"}',
				key: "setup-1",
			},
		] as const) {
			const seen: Array<{ body: string; key: string | null; auth: string | null }> = [];
			const transport = retryIdempotentBillingTransport(async (request) => {
				seen.push({
					body: await request.text(),
					key: request.headers.get("Idempotency-Key"),
					auth: request.headers.get("Authorization"),
				});
				if (seen.length === 1) throw new BillingNetworkError("offline");
				return new Response(null, { status: 204 });
			});
			const response = await transport(
				new Request(`https://api.clawdi.ai${requestCase.path}`, {
					method: "POST",
					headers: { "Idempotency-Key": requestCase.key, Authorization: "Bearer token" },
					body: requestCase.body,
				}),
			);
			expect(response.status).toBe(204);
			expect(seen).toEqual([
				{ body: requestCase.body, key: requestCase.key, auth: "Bearer token" },
				{ body: requestCase.body, key: requestCase.key, auth: "Bearer token" },
			]);
		}
	});

	it("absorbs brief checkout contention with the same idempotent request", async () => {
		const seen: Array<{ body: string; key: string | null }> = [];
		const delays: number[] = [];
		const transport = retryIdempotentBillingTransport(
			async (request) => {
				seen.push({
					body: await request.text(),
					key: request.headers.get("Idempotency-Key"),
				});
				if (seen.length === 1) throw new BillingNetworkError("timeout");
				if (seen.length === 2) {
					return jsonResponse({ detail: "A billing operation is already in progress" }, 409, {
						"Retry-After": "1",
					});
				}
				return new Response(null, { status: 204 });
			},
			async (delayMs) => {
				delays.push(delayMs);
			},
		);
		const response = await transport(
			new Request("https://api.clawdi.ai/v2/subscription/checkout", {
				method: "POST",
				headers: { "Idempotency-Key": "checkout-1" },
				body: '{"plan_slug":"compute_basic"}',
			}),
		);

		expect(response.status).toBe(204);
		expect(delays).toEqual([1_000]);
		expect(seen).toEqual([
			{ body: '{"plan_slug":"compute_basic"}', key: "checkout-1" },
			{ body: '{"plan_slug":"compute_basic"}', key: "checkout-1" },
			{ body: '{"plan_slug":"compute_basic"}', key: "checkout-1" },
		]);
	});

	it("does not retry responses, aborts, or a second network failure", async () => {
		for (const scenario of [
			"response",
			"abort",
			"other-endpoint",
			"setup-finalize",
			"second-failure",
		] as const) {
			let calls = 0;
			const controller = new AbortController();
			const transport = retryIdempotentBillingTransport(async () => {
				calls += 1;
				if (scenario === "response") return new Response(null, { status: 502 });
				if (scenario === "abort") controller.abort();
				throw new BillingNetworkError("offline");
			});
			const path =
				scenario === "other-endpoint"
					? "/v2/subscription/portal"
					: scenario === "setup-finalize"
						? "/v2/wallet/auto-reload/setup-intent/finalize"
						: "/v2/wallet/topup";
			const request = new Request(`https://api.clawdi.ai${path}`, {
				method: "POST",
				headers: { "Idempotency-Key": "topup-1" },
				signal: controller.signal,
			});
			if (scenario === "response") expect((await transport(request)).status).toBe(502);
			else await expect(transport(request)).rejects.toBeInstanceOf(BillingNetworkError);
			expect(calls).toBe(scenario === "second-failure" ? 2 : 1);
		}
	});

	it("uses the generated Wallet Setup endpoints and trusts only setup identities on finalize", async () => {
		const requests: Request[] = [];
		const setupIdentity = `wsetup_${"a".repeat(64)}`;
		const client = testClient(async (request) => {
			requests.push(request.clone());
			if (request.url.endsWith("/setup-intent")) {
				return jsonResponse({
					setup_identity: setupIdentity,
					setup_intent_id: "seti_wallet",
					client_secret: "seti_wallet_secret_private",
					status: "requires_payment_method",
					currency: "usd",
					consent_version: "wallet_auto_reload_off_session_v2",
					amount_policy: "wallet_reload_configured_plus_negative_balance_v1",
					auto_reload_threshold_usd: "5",
					auto_reload_amount_cents: 2_500,
					auto_reload_monthly_cap_cents: 10_000,
				});
			}
			return jsonResponse({});
		});
		const settings = {
			consent_version: "wallet_auto_reload_off_session_v2",
			auto_reload_threshold_usd: "5",
			auto_reload_amount_cents: 2_500,
			auto_reload_monthly_cap_cents: 10_000,
		} as const;

		await client.createWalletAutoReloadSetup(settings, "setup-key");
		await client.finalizeWalletAutoReloadSetup({
			setup_identity: setupIdentity,
			setup_intent_id: "seti_wallet",
		});

		expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
			"/v2/wallet/auto-reload/setup-intent",
			"/v2/wallet/auto-reload/setup-intent/finalize",
		]);
		expect(requests[0]?.headers.get("Idempotency-Key")).toBe("setup-key");
		expect(requests[1]?.headers.get("Idempotency-Key")).toBeNull();
		expect(await requests[0]?.json()).toEqual(settings);
		expect(await requests[1]?.json()).toEqual({
			setup_identity: setupIdentity,
			setup_intent_id: "seti_wallet",
		});
	});
});

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", ...headers },
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
	state: ComputePlanChangeProgress["state"],
	{
		done = false,
		error = null,
		changeKind = "immediate_upgrade",
		billingEffect = changeKind === "funding_source_switch"
			? "future_renewals"
			: "immediate_proration",
		fundingSource = "wallet",
		sourcePlanSlug = "compute_basic",
		targetPlanSlug = changeKind === "funding_source_switch"
			? sourcePlanSlug
			: "compute_performance",
	}: {
		done?: boolean;
		error?: DeploymentOperation["error"];
		changeKind?: ComputePlanChangeKind;
		billingEffect?: ComputePlanChangeBillingEffect;
		fundingSource?: "stripe" | "wallet";
		sourcePlanSlug?: string;
		targetPlanSlug?: string;
	} = {},
): DeploymentOperation {
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
				fundingSource,
				changeKind,
				billingEffect,
				sourcePlanSlug,
				targetPlanSlug,
				targetBillingTermMonths: 1,
				state,
				effectiveAt: NOW,
			},
		},
		done,
		error,
		response:
			done && error === null
				? {
						"@type": "type.googleapis.com/clawdi.v2.DeploymentOperationResponse",
						deployment: hostedDeploymentFixture({ id: "hdep_test" }).resource,
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
				models: [
					{
						id: "gpt-5.6-luna",
						display_name: "GPT-5.6 Luna",
						provider_id: "openai-codex",
						is_default: true,
						is_featured: true,
						description: "Low cost for routine work.",
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
					display_name: "GPT-5.6 Luna",
					provider_id: "openai-codex",
					is_default: true,
					is_featured: true,
					description: "Low cost for routine work.",
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

describe("deployment Skill authority", () => {
	it("uses only V2 Workspace Skill reads and GitHub source mutations", async () => {
		const requests: Request[] = [];
		const client = testClient(async (request) => {
			requests.push(request.clone());
			const path = new URL(request.url).pathname;
			if (path === "/v2/deployments/hdep_test/workspace-skills" && request.method === "GET") {
				return jsonResponse({
					deployment_id: "hdep_test",
					deployment_resource_version: "rv-skills",
					manifest_generation: 4,
					capability: { available: true, reason: "available" },
					items: [],
				});
			}
			if (
				(path === "/v2/deployments/hdep_test/workspace-skills" && request.method === "POST") ||
				path === "/v2/deployments/hdep_test/workspace-skills/review-pr"
			) {
				return jsonResponse({
					deployment_id: "hdep_test",
					deployment_resource_version: request.method === "POST" ? "rv-installed" : "rv-removed",
					manifest_generation: request.method === "POST" ? 5 : 6,
					skill_key: "review-pr",
					desired_state: request.method === "POST" ? "present" : "absent",
					status: "requested",
				});
			}
			throw new Error(`Unexpected request: ${request.method} ${path}`);
		});

		await expect(client.listWorkspaceSkills("hdep_test")).resolves.toMatchObject({ items: [] });
		await expect(
			client.installWorkspaceSkill(
				"hdep_test",
				{ repo: "example/skills", path: "review-pr" },
				"rv-skills",
				"install-attempt",
			),
		).resolves.toMatchObject({
			desired_state: "present",
			status: "requested",
		});
		await expect(
			client.uninstallWorkspaceSkill("hdep_test", "review-pr", "rv-installed", "remove-attempt"),
		).resolves.toMatchObject({
			desired_state: "absent",
		});

		expect(requests.map((request) => request.method)).toEqual(["GET", "POST", "DELETE"]);
		expect(await requests[1]?.json()).toEqual({ repo: "example/skills", path: "review-pr" });
		expect(requests[1]?.headers.get("If-Match")).toBe('"rv-skills"');
		expect(requests[1]?.headers.get("Idempotency-Key")).toBe("install-attempt");
		expect(requests[2]?.headers.get("If-Match")).toBe('"rv-installed"');
		expect(requests[2]?.headers.get("Idempotency-Key")).toBe("remove-attempt");
		expect(
			requests.every((request) => request.headers.get("Authorization") === "Bearer test-token"),
		).toBe(true);
	});

	it("refetches V2 desired state after a CAS conflict and keeps one idempotency key", async () => {
		const requests: Request[] = [];
		let postCount = 0;
		const client = testClient(async (request) => {
			requests.push(request.clone());
			const path = new URL(request.url).pathname;
			if (path === "/v2/deployments/hdep_test/workspace-skills" && request.method === "POST") {
				postCount += 1;
				if (postCount === 1) {
					return jsonResponse(
						{
							detail: {
								code: "resource_version_mismatch",
								message: "Workspace desired state changed.",
							},
						},
						412,
					);
				}
				return jsonResponse({
					deployment_id: "hdep_test",
					deployment_resource_version: "rv-installed",
					manifest_generation: 5,
					skill_key: "review-pr",
					desired_state: "present",
					status: "requested",
				});
			}
			if (path === "/v2/deployments/hdep_test/workspace-skills") {
				return jsonResponse({
					deployment_id: "hdep_test",
					deployment_resource_version: "rv-fresh",
					manifest_generation: 4,
					capability: { available: true, reason: "available" },
					items: [],
				});
			}
			throw new Error(`Unexpected request: ${request.method} ${path}`);
		});

		await expect(
			client.installWorkspaceSkill(
				"hdep_test",
				{ repo: "example/skills", path: "review-pr" },
				"rv-stale",
				"same-attempt",
			),
		).resolves.toMatchObject({
			desired_state: "present",
			status: "requested",
		});

		expect(requests.map((request) => request.method)).toEqual(["POST", "GET", "POST"]);
		expect(requests[0]?.headers.get("If-Match")).toBe('"rv-stale"');
		expect(requests[2]?.headers.get("If-Match")).toBe('"rv-fresh"');
		expect(requests[0]?.headers.get("Idempotency-Key")).toBe("same-attempt");
		expect(requests[2]?.headers.get("Idempotency-Key")).toBe("same-attempt");
	});

	it("surfaces a semantic Workspace Skill conflict without retrying", async () => {
		const requests: Request[] = [];
		const client = testClient(async (request) => {
			requests.push(request.clone());
			return jsonResponse(
				{
					detail: {
						code: "workspace_skill_reserved",
						message: "The bundled clawdi Skill is manifest-managed.",
					},
				},
				409,
			);
		});

		await expect(
			client.installWorkspaceSkill(
				"hdep_test",
				{ repo: "example/skills", path: "clawdi" },
				"rv-current",
				"reserved-attempt",
			),
		).rejects.toMatchObject({
			status: 409,
			payload: { detail: { code: "workspace_skill_reserved" } },
		});
		expect(requests.map((request) => request.method)).toEqual(["POST"]);
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
					return jsonResponse({ detail: "Deploy request not visible yet" }, 404);
				}
				if (requestStatusReads === 2) {
					return jsonResponse({ detail: "Temporary gateway failure" }, 503);
				}
				if (requestStatusReads === 3) {
					return jsonResponse({
						deploy_request_id: intentKey,
						request_status: "ready",
						lineage_tail: {
							deployment_id: "hdep_test",
							agent_id: "44444444-4444-4444-8444-444444444444",
							lineage_version: 1,
							lineage_state: "unaccepted",
							operation: null,
						},
					});
				}
				throw new Error("Accepted checkout deploys must stop request polling");
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
			agentId: "44444444-4444-4444-8444-444444444444",
			deploymentId: "hdep_test",
			operation: null,
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
			`/v2/deployments/by-request/${intentKey}`,
		]);
	});

	it("stops an in-flight deployment request read at its wall-clock deadline", async () => {
		const requests: Request[] = [];
		const deployRequestId = "checkout/race:stable";
		let requestWasAborted = false;
		const client = createBillingClient(async () => "test-token", {
			fetch: async (request) => {
				requests.push(request.clone());
				return await new Promise<Response>((_resolve, reject) => {
					const rejectAbort = () => {
						requestWasAborted = true;
						reject(request.signal.reason ?? new DOMException("Aborted", "AbortError"));
					};
					if (request.signal.aborted) rejectAbort();
					else request.signal.addEventListener("abort", rejectAbort, { once: true });
				});
			},
			deploymentRequestTimeoutMs: 25,
		});

		const startedAt = Date.now();
		await expect(client.waitForDeploymentRequest(deployRequestId)).rejects.toBeInstanceOf(
			BillingNetworkError,
		);
		expect(Date.now() - startedAt).toBeLessThan(1_000);
		expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
			`/v2/deployments/by-request/${encodeURIComponent(deployRequestId)}`,
		]);
		expect(requestWasAborted).toBe(true);
	});

	it("caps zero-delay transient reads independently of the deadline", async () => {
		let requestCount = 0;
		const client = createBillingClient(async () => "test-token", {
			fetch: async () => {
				requestCount += 1;
				return jsonResponse({ detail: "Deploy request not visible yet" }, 404);
			},
			operationPollLimit: 2,
			sleep: async () => undefined,
		});

		await expect(client.waitForDeploymentRequest("checkout-not-visible")).rejects.toBeInstanceOf(
			BillingNetworkError,
		);
		expect(requestCount).toBe(3);
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

		await expect(client.waitForDeploymentRequest(intentKey)).rejects.toMatchObject({
			name: "DeploymentRequestTerminalError",
			request: { deploy_request_id: intentKey, request_status: "failed" },
		});
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

	it("does not retry or wrap a start rejected for ended funding", async () => {
		const requests: string[] = [];
		const client = testClient(async (request) => {
			const path = new URL(request.url).pathname;
			requests.push(`${request.method} ${path}`);
			if (request.method === "GET") {
				return jsonResponse(hostedDeploymentFixture({ id: "hdep_ended", status: "stopped" }));
			}
			return jsonResponse({ code: "funding_revoked_after_accept" }, 409);
		});
		await expect(
			client.setDeploymentDesiredState("hdep_ended", "running", "intent-start"),
		).rejects.toBeInstanceOf(BillingApiError);
		expect(requests).toEqual([
			"GET /v2/deployments/hdep_ended",
			"POST /v2/deployments/hdep_ended/start",
		]);
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
				handoff_url:
					"https://runtime.example/openclaw/#bootstrapToken=one-time-token&bootstrapProfile=owner",
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
		await client.updateDeployment("hdep_update", { language: "zh-CN" }, "intent-update");
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

	it("completes deletion when the deployment is definitively absent", async () => {
		const requests: Request[] = [];
		const client = testClient(async (request) => {
			requests.push(request.clone());
			if (request.method === "GET") {
				return jsonResponse({ detail: "Deployment not found" }, 404);
			}
			return jsonResponse({ deployment_id: "hdep_absent", status: "absent" });
		});

		await expect(
			client.deleteDeployment(
				"hdep_absent",
				{ subscription_choice: "cancel_subscription" },
				"intent-absent",
				"rv-last-known",
			),
		).resolves.toEqual({ deploymentId: "hdep_absent", operation: null });
		expect(requests.map((request) => request.method)).toEqual(["GET", "DELETE"]);
		expect(requests[1]?.headers.get("Idempotency-Key")).toBe("intent-absent");
		expect(requests[1]?.headers.get("If-Match")).toBe('"rv-last-known"');
	});

	it("deletes a definitively absent deployment without a cached resource version", async () => {
		const requests: Request[] = [];
		const client = testClient(async (request) => {
			requests.push(request.clone());
			if (request.method === "GET") {
				return jsonResponse({ detail: "Deployment not found" }, 404);
			}
			return jsonResponse({ deployment_id: "hdep_orphan", status: "absent" });
		});

		await expect(
			client.deleteDeployment(
				"hdep_orphan",
				{ subscription_choice: "keep_subscription" },
				"intent-orphan",
			),
		).resolves.toEqual({ deploymentId: "hdep_orphan", operation: null });
		expect(requests.map((request) => request.method)).toEqual(["GET", "DELETE"]);
		expect(requests[1]?.headers.get("Idempotency-Key")).toBe("intent-orphan");
		expect(requests[1]?.headers.get("If-Match")).toBe('"absent"');
	});

	it("does not delete when the deployment pre-read fails transiently", async () => {
		const requests: Request[] = [];
		const client = testClient(async (request) => {
			requests.push(request.clone());
			return jsonResponse({ detail: "Inventory temporarily unavailable" }, 503);
		});

		await expect(
			client.deleteDeployment(
				"hdep_pre_read_transient",
				{ subscription_choice: "keep_subscription" },
				"intent-pre-read-transient",
			),
		).rejects.toMatchObject({ status: 503 });
		expect(requests.map((request) => request.method)).toEqual(["GET"]);
	});

	it("keeps transient absent-deletion failures rejected", async () => {
		const client = testClient(async (request) => {
			if (request.method === "GET") {
				return jsonResponse(
					hostedDeploymentFixture({ id: "hdep_transient", resourceVersion: "rv-transient" }),
				);
			}
			return jsonResponse(
				{
					detail: "Cloud ownership or cleanup could not be confirmed.",
					code: "cloud_cleanup_temporarily_unavailable",
				},
				503,
			);
		});

		await expect(
			client.deleteDeployment(
				"hdep_transient",
				{ subscription_choice: "cancel_subscription" },
				"intent-transient",
			),
		).rejects.toMatchObject({ status: 503 });
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
			accepted.every(
				(item) =>
					item.operation !== null && !item.operation.done && item.deploymentId === "hdep_test",
			),
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

describe("account compute subscriptions", () => {
	it("lists subscriptions and uses the generated subscription action endpoints", async () => {
		const requests: Request[] = [];
		const client = testClient(async (request) => {
			requests.push(request.clone());
			const path = new URL(request.url).pathname;
			if (path === "/v2/subscriptions") {
				return jsonResponse({
					items: [
						{
							subscription_id: "csub_test",
							plan_slug: "compute_performance",
							funding_source: "stripe",
							status: "active",
							price_cents: 2_000,
							currency: "usd",
							billing_term_months: 1,
							current_period_end: "2026-08-22T00:00:00Z",
							cancel_at_period_end: false,
							deployment_id: "hdep_test",
							agent_name: "Performance agent",
							is_orphan: false,
						},
					],
					has_more: true,
					next_cursor: "cursor-next",
				});
			}
			return jsonResponse({
				status: "active",
				funding_source: "stripe",
				billing_term_months: 1,
				cancel_at_period_end: path.endsWith("/cancel"),
				current_period_end: "2026-08-22T00:00:00Z",
			});
		});

		await expect(client.getSubscriptions(3, "cursor-current")).resolves.toEqual({
			items: [
				expect.objectContaining({
					subscription_id: "csub_test",
					agent_name: "Performance agent",
					is_orphan: false,
				}),
			],
			has_more: true,
			next_cursor: "cursor-next",
		});
		await client.cancelSubscription({ subscription_id: "csub_test" });
		await client.resumeSubscription({ subscription_id: "csub_test" });
		await client.cancelScheduledPlanChange({ subscription_id: "csub_test" });
		await client.cancelScheduledPlanChange({ deployment_id: "hdep_test" });

		expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
			["GET", "/v2/subscriptions"],
			["POST", "/v2/subscription/cancel"],
			["POST", "/v2/subscription/resume"],
			["POST", "/v2/subscription/plan/cancel-scheduled-change"],
			["POST", "/v2/subscription/plan/cancel-scheduled-change"],
		]);
		expect(await requests[1]?.json()).toEqual({ subscription_id: "csub_test" });
		expect(await requests[2]?.json()).toEqual({ subscription_id: "csub_test" });
		expect(await requests[3]?.json()).toEqual({ subscription_id: "csub_test" });
		expect(await requests[4]?.json()).toEqual({ deployment_id: "hdep_test" });
		expect(new URL(requests[0]?.url ?? "").searchParams).toEqual(
			new URLSearchParams({ limit: "3", cursor: "cursor-current" }),
		);
		expect(
			requests.every((request) => request.headers.get("Authorization") === "Bearer test-token"),
		).toBe(true);
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
			operationName: "operations/plan-change-1",
			effectiveAt: NOW,
			changeKind: "immediate_upgrade",
			billingEffect: "immediate_proration",
			fundingSource: "wallet",
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
			operationName: "operations/plan-change-1",
			effectiveAt: NOW,
			changeKind: "immediate_upgrade",
			billingEffect: "immediate_proration",
			fundingSource: "wallet",
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

	it("keeps funding-source switch context on terminal outcomes", async () => {
		const completed = planChangeOperation("complete", {
			done: true,
			changeKind: "funding_source_switch",
			fundingSource: "stripe",
		});
		const completeClient = testClient(async () => jsonResponse(completed));

		await expect(completeClient.checkPlanChange(completed.name)).resolves.toEqual({
			kind: "complete",
			operationName: "operations/plan-change-1",
			effectiveAt: NOW,
			changeKind: "funding_source_switch",
			billingEffect: "future_renewals",
			fundingSource: "stripe",
		});

		const failed = planChangeOperation("failed", {
			done: true,
			changeKind: "funding_source_switch",
			fundingSource: "stripe",
			error: {
				code: 9,
				message: "A card is required.",
				details: [
					{
						"@type": "type.googleapis.com/clawdi.v2.LifecycleProblemDetails",
						type: "https://api.clawdi.ai/problems/payment-method-required",
						title: "A card is required",
						status: 409,
						detail: "payment_method_required",
						code: "payment_method_required",
						phase: "plan_change",
						retryable: false,
						conditionReason: "PaymentMethodRequired",
						conditionMessage: "Add a card and try again.",
						observedGeneration: 2,
					},
				],
			},
		});
		const failedClient = testClient(async () => jsonResponse(failed));

		try {
			await failedClient.checkPlanChange(failed.name);
			throw new Error("Expected the plan change to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(PlanChangeTerminalError);
			if (!(error instanceof PlanChangeTerminalError)) throw error;
			expect(error.changeKind).toBe("funding_source_switch");
			expect(error.fundingSource).toBe("stripe");
			expect(error.operationName).toBe("operations/plan-change-1");
		}
	});

	it("rejects incomplete or mismatched plan-change metadata instead of reporting success", async () => {
		const mismatched = planChangeOperation("complete", {
			done: true,
			changeKind: "funding_source_switch",
			billingEffect: "immediate_proration",
			fundingSource: "stripe",
		});
		const missingFundingSource = planChangeOperation("complete", { done: true });
		if (missingFundingSource.metadata.planChange) {
			Reflect.deleteProperty(missingFundingSource.metadata.planChange, "fundingSource");
		}
		const missingMetadata = {
			...planChangeOperation("complete", { done: true }),
			metadata: undefined,
		};
		const invalidResponse = {
			...planChangeOperation("complete", { done: true }),
			response: { "@type": "type.googleapis.com/google.protobuf.Empty" },
		};

		for (const operation of [mismatched, missingFundingSource, missingMetadata, invalidResponse]) {
			const client = testClient(async () => jsonResponse(operation));
			await expect(client.checkPlanChange(operation.name)).rejects.toMatchObject({ status: 502 });
		}
	});
});
