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
	test("store-only admission changes only the HTTP body and preserves key and caller signal", async () => {
		const requests: { body: unknown; key: string | null }[] = [];
		const client = createHostedComputeClient({
			...options,
			fetch: async (request) => {
				requests.push({ body: await request.json(), key: request.headers.get("Idempotency-Key") });
				return Response.json(operation, { status: 202 });
			},
		});
		const request = Object.freeze({ ...body, deploy_request_id: "store-key" });
		const before = JSON.stringify(request);
		await client.createEntitledDeployment(request, "store-key", undefined, {
			computeSource: "store",
		});
		await client.createEntitledDeployment(request, "store-key");
		await client.createEntitledDeployment(request, "store-key", undefined, {});
		expect(requests).toEqual([
			{ body: { ...request, compute_source: "store" }, key: "store-key" },
			{ body: request, key: "store-key" },
			{ body: request, key: "store-key" },
		]);
		expect(JSON.stringify(request)).toBe(before);
		const controller = new AbortController();
		controller.abort(new Error("Account changed"));
		await expect(
			client.createEntitledDeployment(request, "store-key", controller.signal, {
				computeSource: "store",
			}),
		).rejects.toBe(controller.signal.reason);
		expect(requests).toHaveLength(3);
	});

	test("assigns one exact reusable subscription and rejects anything but an activation", async () => {
		const requests: { url: string; body: unknown; key: string | null }[] = [];
		let response: unknown = {
			flow_type: "subscription_activation",
			funding_source: "stripe",
			action_url: null,
			checkout_url: "",
			client_secret: null,
			subscription_id: "csub_a",
			invoice_id: null,
			deploy_request_id: "reuse-key",
		};
		const client = createHostedComputeClient({
			...options,
			fetch: async (request) => {
				requests.push({
					url: request.url,
					body: await request.json(),
					key: request.headers.get("Idempotency-Key"),
				});
				return Response.json(response);
			},
		});
		const request = { ...body, deploy_request_id: "reuse-key" };
		const subscription = {
			subscriptionId: "csub_a",
			planSlug: "compute_basic",
			billingTermMonths: 12,
			fundingSource: "stripe",
		} as const;
		await client.assignReusableSubscription(request, "reuse-key", subscription);
		expect(requests).toEqual([
			{
				url: "https://compute.example.test/v2/subscription/checkout",
				key: "reuse-key",
				body: {
					plan_slug: "compute_basic",
					billing_term_months: 12,
					funding_source: "stripe",
					ui_mode: "custom",
					subscription_selection: { mode: "existing", subscription_id: "csub_a" },
					deploy_config: request,
				},
			},
		]);
		await expect(
			client.assignReusableSubscription(request, "reuse-key", {
				...subscription,
				planSlug: "compute_performance",
			}),
		).rejects.toMatchObject({ code: "subscription_plan_mismatch" });
		response = { flow_type: "checkout_session", checkout_url: "https://checkout.example" };
		await expect(
			client.assignReusableSubscription(request, "reuse-key", subscription),
		).rejects.toBeInstanceOf(ApiClientResponseError);
	});

	test("sends card and Wallet subscription commands once, to Web's endpoints", async () => {
		const requests: { url: string; body: unknown }[] = [];
		const client = createHostedComputeClient({
			...options,
			fetch: async (request) => {
				requests.push({ url: request.url, body: await request.json() });
				return Response.json({
					subscription_id: "csub_a",
					status: "active",
					cancel_at_period_end: true,
					action_state: "applied",
				});
			},
		});
		const target = { subscription_id: "csub_a" };
		await client.cancelSubscription(target);
		await client.resumeSubscription(target);
		await client.cancelScheduledPlanChange(target);
		expect(requests).toEqual(
			[
				"subscription/cancel",
				"subscription/resume",
				"subscription/plan/cancel-scheduled-change",
			].map((path) => ({ url: `https://compute.example.test/v2/${path}`, body: target })),
		);
	});

	test("exposes validated Retry-After guidance without retrying admission in the shared client", async () => {
		for (const [header, expected] of [
			["5", 5000],
			["0", 0],
			["invalid", null],
			["-1", null],
			["1.5", null],
			["2026-10-08T00:00:00Z", null],
			["Wed, 21 Oct 2015 07:28:00 GMT", 0],
			["999999999999999", null],
			[null, null],
		] as const) {
			let sends = 0;
			const client = createHostedComputeClient({
				...options,
				fetch: async () => {
					sends++;
					return Response.json(
						{ code: "compute_entitlement_pending" },
						{
							status: 409,
							headers: header === null ? {} : { "Retry-After": header },
						},
					);
				},
			});
			await expect(
				client.createEntitledDeployment(body, "store-key", undefined, { computeSource: "store" }),
			).rejects.toMatchObject({ code: "compute_entitlement_pending", retryAfterMs: expected });
			expect(sends).toBe(1);
		}
		const client = createHostedComputeClient({
			...options,
			fetch: async () =>
				Response.json(
					{ code: "deployment_plan_release_pending" },
					{
						status: 409,
						headers: { "Retry-After": new Date(Date.now() + 60_000).toUTCString() },
					},
				),
		});
		try {
			await client.createEntitledDeployment(body, "store-key");
			throw new Error("Expected rejection");
		} catch (error) {
			if (!(error instanceof ApiClientError)) throw error;
			expect(error.retryAfterMs).toBeGreaterThan(58_000);
			expect(error.retryAfterMs).toBeLessThanOrEqual(60_000);
		}
	});

	test("account termination requires authenticated DELETE and exact 204, without retrying failures", async () => {
		let status = 204;
		const requests: { method: string; path: string; auth: string | null; body: string }[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				requests.push({
					method: request.method,
					path: new URL(request.url).pathname,
					auth: request.headers.get("authorization"),
					body: await request.text(),
				});
				return status === 204 ? new Response(null, { status }) : Response.json({}, { status });
			},
		});
		const client = createHostedComputeClient({
			...options,
			baseUrl: `${server.url.href}v2`,
			fetch: (request, init) => fetch(request, init),
		});
		try {
			expect(await client.deleteAccount()).toBeNull();
			expect(requests).toEqual([
				{ method: "DELETE", path: "/v1/me", auth: "Bearer owner-token", body: "" },
			]);
			status = 200;
			await expect(client.deleteAccount()).rejects.toBeInstanceOf(ApiClientResponseError);
			status = 403;
			await expect(client.deleteAccount()).rejects.toMatchObject({ status: 403 });
			status = 500;
			await expect(client.deleteAccount()).rejects.toMatchObject({ status: 500 });
			expect(requests).toHaveLength(4);
		} finally {
			server.stop(true);
		}
	});
	test("pages, marks read up to an item and deletes account notifications", async () => {
		const requests: { method: string; path: string; body: string }[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const url = new URL(request.url);
				requests.push({
					method: request.method,
					path: `${url.pathname}${url.search}`,
					body: await request.text(),
				});
				if (request.method === "DELETE") return new Response(null, { status: 204 });
				if (request.method === "POST") return Response.json({ updated_count: 2 });
				return Response.json({ items: [], unread_count: 0, next_cursor: null });
			},
		});
		const client = createHostedComputeClient({
			...options,
			baseUrl: `${server.url.href}v2`,
			fetch: (request, init) => fetch(request, init),
		});
		try {
			expect(await client.listNotifications({ limit: 50, cursor: "c-2" })).toEqual({
				items: [],
				unread_count: 0,
				next_cursor: null,
			});
			expect(await client.markNotificationsRead("n-1")).toEqual({ updated_count: 2 });
			expect(await client.deleteNotification("n-1")).toBeNull();
			await expect(client.deleteNotification("..")).rejects.toMatchObject({
				code: "invalid_resource_id",
			});
			expect(requests).toEqual([
				{ method: "GET", path: "/v1/me/notifications?limit=50&cursor=c-2", body: "" },
				{
					method: "POST",
					path: "/v1/me/notifications/read-all",
					body: JSON.stringify({ up_to_id: "n-1" }),
				},
				{ method: "DELETE", path: "/v1/me/notifications/n-1", body: "" },
			]);
		} finally {
			server.stop(true);
		}
	});
	test("serializes catalog, paging, preview and existing Basic/Performance admission over HTTP", async () => {
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
			await client.getWalletPaymentMethods();
			const cursor = "next &+/%?你好";
			await client.getSubscriptions({ limit: 7, cursor });
			await client.getReusableSubscriptions({ limit: 8, cursor });
			await client.getIncludedBasicAvailability();
			await client.getWalletTransactions({ limit: 9, cursor });
			await client.getUsage({ days: 30, agent_id: "agent &+/1" });
			await client.quoteSubscription(quote);
			const key = "!".repeat(191);
			const deploymentBody = { ...body, deploy_request_id: key };
			const performanceBody: HostedDeployRequest = {
				...body,
				compute_plan_slug: "compute_performance",
				deploy_request_id: "performance-key",
			};
			expect(await client.createIncludedDeployment(deploymentBody, key)).toEqual(operation);
			expect(await client.createEntitledDeployment(performanceBody, "performance-key")).toEqual(
				operation,
			);
			expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
				["GET", "/v1/me"],
				["GET", "/v2/subscription/plans"],
				["GET", "/v2/ai-providers/managed/models"],
				["GET", "/v2/wallet"],
				["GET", "/v2/wallet/payment-methods"],
				["GET", "/v2/subscriptions"],
				["GET", "/v2/subscriptions/reusable"],
				["GET", "/v2/subscriptions/included-basic"],
				["GET", "/v2/wallet/transactions"],
				["GET", "/v2/usage"],
				["POST", "/v2/subscription/quote"],
				["POST", "/v2/deployments"],
				["POST", "/v2/deployments"],
			]);
			for (const request of requests) {
				expect(request.headers.get("Authorization")).toBe("Bearer owner-token");
				const url = new URL(request.url);
				if (url.pathname === "/v2/usage") {
					expect([...url.searchParams.entries()]).toEqual([
						["days", "30"],
						["agent_id", "agent &+/1"],
					]);
				} else if (url.search) {
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
					const performance = request.headers.get("Idempotency-Key") === "performance-key";
					expect(request.body).toEqual(
						url.pathname === "/v2/deployments"
							? performance
								? performanceBody
								: deploymentBody
							: quote,
					);
					expect(request.headers.get("Idempotency-Key")).toBe(
						url.pathname === "/v2/deployments" ? (performance ? "performance-key" : key) : null,
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
			await expect(
				client.createEntitledDeployment({ ...body, compute_plan_slug: "compute_performance" }, key),
			).rejects.toMatchObject({ status: 400, code: "invalid_idempotency_key" });
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
				client.createEntitledDeployment({ ...body, deploy_request_id: deployRequestId }, "valid"),
			).rejects.toMatchObject({ status: 409, code: "deploy_request_id_mismatch" });
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
			() =>
				client.createEntitledDeployment(
					{ ...body, compute_plan_slug: "compute_performance" },
					"same-key",
				),
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
		expect(sends).toBe(3);
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
		const result = client.createEntitledDeployment(
			{ ...body, compute_plan_slug: "compute_performance" },
			"key",
			controller.signal,
		);
		await sent;
		controller.abort(reason);
		await expect(result).rejects.toBe(reason);
		expect(requestSignal?.aborted).toBe(true);
		release(Response.json(operation, { status: 202 }));
	});
});
