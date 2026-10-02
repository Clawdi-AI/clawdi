import { describe, expect, test } from "bun:test";
import { createHostedComputeClient } from "./compute-client";
import type { components } from "./deploy.generated";
import type { HostedDeployRequest, HostedDeploySubscriptionQuoteRequest } from "./deploy-wizard";
import { ApiClientError, type ApiClientOptions, ApiClientResponseError } from "./read-transport";

const body: HostedDeployRequest = {
	compute_plan_slug: "compute_basic",
	runtime: "hermes",
	ai_provider_auth_kind: "managed",
	name: "Agent & + /",
};
const quote: HostedDeploySubscriptionQuoteRequest = {
	plan_slug: "compute_performance",
	billing_term_months: 12,
	funding_source: "wallet",
};
const options: ApiClientOptions = {
	baseUrl: "https://compute.example.test/v2/",
	getToken: async () => "owner-token",
	fetch: async () => Response.json({}),
};
const profile: components["schemas"]["V1UserResponse"] = {
	id: "usr-a",
	clerk_id: "clerk-a",
	email: null,
	name: null,
	created_at: "2026-10-02T00:00:00Z",
	updated_at: "2026-10-02T00:00:00Z",
	settings: {},
	capabilities: {
		can_use_v1: false,
		can_use_v2: true,
		can_create_v1_deployment: false,
	},
};
const operation: components["schemas"]["LongRunningOperation"] = {
	name: "operations/create-a",
	done: false,
	metadata: {
		"@type": "type.googleapis.com/clawdi.v2.DeploymentOperationMetadata",
		deploymentId: "hdep-a",
		verb: "create",
		targetGeneration: 1,
		manifestETag: "etag-a",
		createTime: "2026-10-02T00:00:00Z",
		updateTime: "2026-10-02T00:00:00Z",
	},
};

describe("Hosted compute client", () => {
	test("serializes catalog, paging, preview and Basic admission over HTTP", async () => {
		const requests: {
			url: string;
			method: string;
			headers: Headers;
			body: unknown;
		}[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const snapshot = {
					url: request.url,
					method: request.method,
					headers: new Headers(request.headers),
					body: request.method === "POST" ? await request.json() : undefined,
				};
				requests.push(snapshot);
				if (new URL(request.url).pathname === "/v1/me") return Response.json(profile);
				if (request.method === "POST" && new URL(request.url).pathname === "/v2/deployments") {
					return Response.json(operation, { status: 202 });
				}
				return Response.json({});
			},
		});
		const client = createHostedComputeClient({
			...options,
			baseUrl: `${server.url.href}v2/`,
			fetch: (request, init) => fetch(request, init),
		});
		try {
			expect(await client.getProductCapabilities()).toEqual(profile.capabilities);
			await client.listPlans();
			await client.getManagedModels();
			await client.getWallet();
			const cursor = "next &+/%?你好";
			await client.getSubscriptions({ limit: 7, cursor });
			await client.getReusableSubscriptions({ limit: 8, cursor });
			await client.getIncludedBasicAvailability();
			await client.getWalletTransactions({ limit: 9, cursor });
			await client.quoteSubscription(quote);
			const key = "!".repeat(191);
			const deploymentBody = { ...body, deploy_request_id: key };
			expect(await client.createIncludedDeployment(deploymentBody, key)).toEqual(operation);
			expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
				["GET", "/v1/me"],
				["GET", "/v2/subscription/plans"],
				["GET", "/v2/ai-providers/managed/models"],
				["GET", "/v2/wallet"],
				["GET", "/v2/subscriptions"],
				["GET", "/v2/subscriptions/reusable"],
				["GET", "/v2/subscriptions/included-basic"],
				["GET", "/v2/wallet/transactions"],
				["POST", "/v2/subscription/quote"],
				["POST", "/v2/deployments"],
			]);
			for (const request of requests) {
				expect(request.headers.get("Authorization")).toBe("Bearer owner-token");
				const url = new URL(request.url);
				if (url.search) {
					expect(url.searchParams.get("cursor")).toBe(cursor);
					expect([...url.searchParams.keys()]).toEqual(["limit", "cursor"]);
				}
				if (url.pathname === "/v2/subscriptions") expect(url.searchParams.get("limit")).toBe("7");
				if (url.pathname === "/v2/subscriptions/reusable")
					expect(url.searchParams.get("limit")).toBe("8");
				if (url.pathname === "/v2/wallet/transactions")
					expect(url.searchParams.get("limit")).toBe("9");
				if (request.method === "POST") {
					expect(request.headers.get("Content-Type")).toBe("application/json");
					expect(request.body).toEqual(url.pathname === "/v2/deployments" ? deploymentBody : quote);
					expect(request.headers.get("Idempotency-Key")).toBe(
						url.pathname === "/v2/deployments" ? key : null,
					);
				}
			}
		} finally {
			server.stop(true);
		}
	});

	test("rejects missing or malformed product capabilities with safe response errors", async () => {
		for (const response of [
			null,
			{},
			{ capabilities: null },
			{ capabilities: [] },
			{ capabilities: { can_use_v2: true } },
			{ capabilities: { ...profile.capabilities, can_use_v2: "true" } },
			{ capabilities: { ...profile.capabilities, can_use_v1: 1 } },
			{ capabilities: { ...profile.capabilities, can_create_v1_deployment: null } },
		]) {
			const client = createHostedComputeClient({
				...options,
				fetch: async () => Response.json(response),
			});
			await expect(client.getProductCapabilities()).rejects.toBeInstanceOf(ApiClientResponseError);
		}
	});

	test("rejects invalid keys, plans and mismatched request IDs before token retrieval or networking", async () => {
		let tokens = 0;
		let sends = 0;
		const client = createHostedComputeClient({
			...options,
			getToken: async () => {
				tokens += 1;
				return "token";
			},
			fetch: async () => {
				sends += 1;
				return Response.json(operation);
			},
		});
		for (const key of [
			"",
			" ",
			"key value",
			"key\n",
			"\rkey",
			"\tkey",
			"é",
			"\x7f",
			"a".repeat(192),
			"a".repeat(255),
		]) {
			await expect(client.createIncludedDeployment(body, key)).rejects.toMatchObject({
				status: 400,
				code: "invalid_idempotency_key",
				category: "invalid_request",
			});
		}
		await expect(
			client.createIncludedDeployment(
				{ ...body, compute_plan_slug: "compute_performance" },
				"valid",
			),
		).rejects.toMatchObject({
			status: 400,
			code: "compute_basic_required",
		});
		for (const deployRequestId of ["other-key", ""]) {
			await expect(
				client.createIncludedDeployment({ ...body, deploy_request_id: deployRequestId }, "valid"),
			).rejects.toMatchObject({
				status: 409,
				code: "deploy_request_id_mismatch",
				category: "conflict",
			});
		}
		expect(tokens).toBe(0);
		expect(sends).toBe(0);
		await client.createIncludedDeployment({ ...body, deploy_request_id: null }, "~");
		expect(sends).toBe(1);
	});

	test("uses safe error categories and never retries either POST", async () => {
		let sends = 0;
		const client = createHostedComputeClient({
			...options,
			fetch: async () => {
				sends += 1;
				return Response.json(
					{ code: "compute_entitlement_required", detail: "private server detail" },
					{ status: 409 },
				);
			},
		});
		for (const action of [
			() => client.quoteSubscription(quote),
			() => client.createIncludedDeployment(body, "same-key"),
		]) {
			try {
				await action();
				throw new Error("Expected rejection");
			} catch (error) {
				expect(error).toBeInstanceOf(ApiClientError);
				if (!(error instanceof ApiClientError)) throw error;
				expect(error.category).toBe("conflict");
				expect(error.code).toBe("compute_entitlement_required");
				expect(error.message).not.toContain("private server detail");
			}
		}
		expect(sends).toBe(2);
	});

	test("fences late mutation results on caller cancellation", async () => {
		let release: (response: Response) => void = () => {};
		let started: () => void = () => {};
		const pending = new Promise<Response>((resolve) => {
			release = resolve;
		});
		const sent = new Promise<void>((resolve) => {
			started = resolve;
		});
		let requestSignal: AbortSignal | undefined;
		const client = createHostedComputeClient({
			...options,
			fetch: async (request) => {
				requestSignal = request.signal;
				started();
				return pending;
			},
		});
		const controller = new AbortController();
		const reason = new Error("Account generation changed");
		const result = client.createIncludedDeployment(body, "key", controller.signal);
		await sent;
		controller.abort(reason);
		await expect(result).rejects.toBe(reason);
		expect(requestSignal?.aborted).toBe(true);
		release(Response.json(operation, { status: 202 }));
	});
});
