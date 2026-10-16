import { describe, expect, test } from "bun:test";
import { createHostedComputeClient } from "./compute-client";
import type { components } from "./deploy.generated";
import type { HostedDeployRequest, HostedDeploySubscriptionQuoteRequest } from "./deploy-wizard";
import { ApiClientError, type ApiClientOptions, ApiClientResponseError } from "./read-transport";
import { hostedCheckoutSends } from "./subscription-create";

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

	test("starts a new Wallet subscription with Web's request and the confirmed quote", async () => {
		const requests: { url: string; body: unknown; key: string | null }[] = [];
		let response: unknown = {
			flow_type: "subscription_activation",
			funding_source: "wallet",
			action_url: null,
			checkout_url: "",
			client_secret: null,
			subscription_id: "csub_w",
			invoice_id: "in_w",
			deployment_id: "hdep_w",
			deploy_request_id: "wallet-key",
		};
		let sends = 0;
		const client = createHostedComputeClient({
			...options,
			fetch: async (request) => {
				sends++;
				requests.push({
					url: request.url,
					body: await request.json(),
					key: request.headers.get("Idempotency-Key"),
				});
				return response instanceof Response ? response : Response.json(response);
			},
		});
		const request = { ...body, deploy_request_id: "wallet-key" };
		const walletQuote = {
			plan_slug: "compute_basic",
			billing_term_months: 1,
			funding_source: "wallet",
			currency: "usd",
			term_price_cents: 1000,
			preview_invoice_id: "upcoming_in",
			expires_at: "2026-10-09T00:15:00Z",
			debit_amount_usd: "10.00",
			balance_before_usd: "30.00",
			balance_after_usd: "20.00",
		} as const;
		await expect(
			client.createWalletSubscriptionDeployment(request, "wallet-key", walletQuote),
		).resolves.toMatchObject({ deployment_id: "hdep_w" });
		expect(requests).toEqual([
			{
				url: "https://compute.example.test/v2/subscription/checkout",
				key: "wallet-key",
				body: {
					plan_slug: "compute_basic",
					billing_term_months: 1,
					funding_source: "wallet",
					ui_mode: "custom",
					subscription_selection: { mode: "new" },
					deploy_config: request,
					quote: walletQuote,
				},
			},
		]);
		await expect(
			client.createWalletSubscriptionDeployment(request, "wallet-key", {
				...walletQuote,
				plan_slug: "compute_performance",
			}),
		).rejects.toMatchObject({ code: "subscription_plan_mismatch" });
		await expect(
			client.createWalletSubscriptionDeployment(request, "wallet-key", {
				...walletQuote,
				funding_source: "stripe",
			}),
		).rejects.toMatchObject({ code: "wallet_quote_required" });
		await expect(
			client.createWalletSubscriptionDeployment(request, "other-key", walletQuote),
		).rejects.toMatchObject({ code: "deploy_request_id_mismatch" });
		expect(sends).toBe(1);
		response = Response.json(
			{ detail: { code: "insufficient_wallet_balance", shortfall_usd: "5.00" } },
			{ status: 402 },
		);
		await expect(
			client.createWalletSubscriptionDeployment(request, "wallet-key", walletQuote),
		).rejects.toMatchObject({ status: 402, code: "insufficient_wallet_balance" });
		response = { flow_type: "checkout_session", checkout_url: "https://checkout.example" };
		await expect(
			client.createWalletSubscriptionDeployment(request, "wallet-key", walletQuote),
		).rejects.toBeInstanceOf(ApiClientResponseError);
		expect(sends).toBe(3);
	});

	test("retries checkout like Web: same key and body, short Retry-After or transport loss, three sends", async () => {
		const activation = {
			flow_type: "subscription_activation",
			funding_source: "wallet",
			action_url: null,
			checkout_url: "",
			client_secret: null,
			subscription_id: "csub_w",
			invoice_id: null,
			deployment_id: "hdep_w",
			deploy_request_id: "retry-key",
		};
		const request = { ...body, deploy_request_id: "retry-key" };
		const walletQuote = {
			plan_slug: "compute_basic",
			billing_term_months: 1,
			funding_source: "wallet",
			currency: "usd",
			term_price_cents: 1000,
			expires_at: "2026-10-09T00:15:00Z",
			debit_amount_usd: "10.00",
			balance_before_usd: "30.00",
			balance_after_usd: "20.00",
		} as const;
		const run = async (replies: (() => Response)[]) => {
			const sent: { key: string | null; body: string }[] = [];
			const client = createHostedComputeClient({
				...options,
				fetch: async (sentRequest) => {
					sent.push({
						key: sentRequest.headers.get("Idempotency-Key"),
						body: await sentRequest.text(),
					});
					const reply = replies[sent.length - 1];
					if (!reply) throw new Error("Unexpected send");
					return reply();
				},
			});
			const result = await client
				.createWalletSubscriptionDeployment(request, "retry-key", walletQuote)
				.then(
					(value) => value,
					(error: unknown) => error,
				);
			expect(new Set(sent.map((item) => JSON.stringify(item))).size).toBe(1);
			return { result, sends: sent.length };
		};
		const busy = (status: number, retryAfter: string | null) => () =>
			Response.json(
				{ detail: "A billing operation is already in progress" },
				{ status, headers: retryAfter === null ? {} : { "Retry-After": retryAfter } },
			);
		const ok = () => Response.json(activation, { status: 202 });
		const lost = () => {
			throw new TypeError("Network request failed");
		};
		expect(await run([busy(409, "0"), busy(503, "0"), ok])).toEqual({
			result: activation,
			sends: 3,
		});
		expect(await run([lost, ok])).toEqual({ result: activation, sends: 2 });
		const exhausted = await run([busy(503, "0"), busy(503, "0"), busy(503, "0")]);
		expect(exhausted.sends).toBe(3);
		expect(exhausted.result).toMatchObject({ status: 503 });
		expect(hostedCheckoutSends(exhausted.result)).toBe(3);
		expect(hostedCheckoutSends((await run([busy(422, null)])).result)).toBe(1);
		for (const reply of [busy(409, null), busy(409, "3"), busy(502, "0"), busy(402, "0")])
			expect((await run([reply])).sends).toBe(1);
	});

	test("errors carry the server's HTTP Date, and only a valid one", async () => {
		for (const [date, expected] of [
			["Sat, 10 Oct 2026 00:30:00 GMT", Date.parse("2026-10-10T00:30:00Z")],
			["2026-10-10T00:30:00Z", null],
			[null, null],
		] as const) {
			const client = createHostedComputeClient({
				...options,
				fetch: async () =>
					Response.json(
						{ detail: "Deployment request not found" },
						{ status: 404, headers: date === null ? {} : { Date: date } },
					),
			});
			await expect(client.listPlans()).rejects.toMatchObject({
				status: 404,
				serverDateMs: expected,
			});
		}
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

describe("existing-Agent subscriptions and plan changes", () => {
	const activation = {
		flow_type: "subscription_activation",
		funding_source: "wallet",
		action_url: null,
		checkout_url: "",
		client_secret: null,
		subscription_id: "csub_w",
		invoice_id: null,
		deployment_id: "hdep_stopped",
		deploy_request_id: null,
	};
	const walletQuote = {
		plan_slug: "compute_basic",
		billing_term_months: 1,
		funding_source: "wallet",
		currency: "usd",
		term_price_cents: 1000,
		preview_invoice_id: null,
		expires_at: "2026-10-16T00:15:00Z",
		debit_amount_usd: "10.00",
		balance_before_usd: "30.00",
		balance_after_usd: "20.00",
	} as const;
	const wallet = {
		planSlug: "compute_basic",
		billingTermMonths: 1,
		fundingSource: "wallet",
	} as const;

	test("activates an existing Agent with upgrade_deployment_id, the quote only for a new Wallet subscription", async () => {
		const sent: { url: string; key: string | null; body: unknown }[] = [];
		const client = createHostedComputeClient({
			...options,
			fetch: async (request) => {
				sent.push({
					url: request.url,
					key: request.headers.get("Idempotency-Key"),
					body: await request.json(),
				});
				return Response.json(activation);
			},
		});
		await client.activateDeploymentSubscription({
			deploymentId: "hdep_stopped",
			subscriptionSelection: { mode: "new" },
			selection: wallet,
			idempotencyKey: "key-new",
			quote: walletQuote,
		});
		await client.activateDeploymentSubscription({
			deploymentId: "hdep_stopped",
			subscriptionSelection: { mode: "existing", subscription_id: "csub_card" },
			selection: {
				planSlug: "compute_performance",
				billingTermMonths: 12,
				fundingSource: "stripe",
			},
			idempotencyKey: "key-existing",
			quote: null,
		});
		expect(sent).toEqual([
			{
				url: "https://compute.example.test/v2/subscription/checkout",
				key: "key-new",
				body: {
					plan_slug: "compute_basic",
					billing_term_months: 1,
					funding_source: "wallet",
					ui_mode: "custom",
					subscription_selection: { mode: "new" },
					upgrade_deployment_id: "hdep_stopped",
					quote: walletQuote,
				},
			},
			{
				url: "https://compute.example.test/v2/subscription/checkout",
				key: "key-existing",
				body: {
					plan_slug: "compute_performance",
					billing_term_months: 12,
					funding_source: "stripe",
					ui_mode: "custom",
					subscription_selection: { mode: "existing", subscription_id: "csub_card" },
					upgrade_deployment_id: "hdep_stopped",
				},
			},
		]);
		// A new subscription is Wallet-funded with its matching quote; assignment never carries one.
		for (const request of [
			{ subscriptionSelection: { mode: "new" }, selection: wallet, quote: null },
			{
				subscriptionSelection: { mode: "new" },
				selection: { ...wallet, fundingSource: "stripe" },
				quote: walletQuote,
			},
			{
				subscriptionSelection: { mode: "new" },
				selection: { ...wallet, billingTermMonths: 12 },
				quote: walletQuote,
			},
			{
				subscriptionSelection: { mode: "existing", subscription_id: "csub_card" },
				selection: wallet,
				quote: walletQuote,
			},
		] as const)
			await expect(
				client.activateDeploymentSubscription({
					deploymentId: "hdep_stopped",
					idempotencyKey: "key-invalid",
					...request,
				}),
			).rejects.toBeInstanceOf(ApiClientError);
		expect(sent).toHaveLength(2);
	});

	test("repeats the same key and body across the three-send retry", async () => {
		const sent: string[] = [];
		const replies = [
			() => {
				throw new TypeError("Network request failed");
			},
			() => Response.json({ detail: "busy" }, { status: 409, headers: { "Retry-After": "0" } }),
			() => Response.json(activation),
		];
		const client = createHostedComputeClient({
			...options,
			fetch: async (request) => {
				sent.push(`${request.headers.get("Idempotency-Key")} ${await request.text()}`);
				const reply = replies[sent.length - 1];
				if (!reply) throw new Error("Unexpected send");
				return reply();
			},
		});
		await expect(
			client.activateDeploymentSubscription({
				deploymentId: "hdep_stopped",
				subscriptionSelection: { mode: "new" },
				selection: wallet,
				idempotencyKey: "key-retry",
				quote: walletQuote,
			}),
		).resolves.toMatchObject({ deployment_id: "hdep_stopped" });
		expect(sent).toHaveLength(3);
		expect(new Set(sent).size).toBe(1);
	});

	test("reads hosted's typed checkout refusals (LifecycleProblemDetails) without retrying", async () => {
		let sends = 0;
		const problem = (status: number, code: string) =>
			Response.json(
				{
					type: `https://api.clawdi.ai/problems/deployments/${code}`,
					title: "Wallet subscription request was not accepted",
					status,
					detail: "The wallet quote expired; request a fresh quote",
					code,
					phase: "admission",
					retryable: false,
				},
				{
					status,
					headers: {
						"Content-Type": "application/problem+json",
						Date: "Fri, 16 Oct 2026 00:30:00 GMT",
					},
				},
			);
		for (const [status, code] of [
			[409, "wallet_quote_expired"],
			[400, "upgrade_target_unavailable"],
		] as const) {
			const client = createHostedComputeClient({
				...options,
				fetch: async () => {
					sends++;
					return problem(status, code);
				},
			});
			const error = await client
				.activateDeploymentSubscription({
					deploymentId: "hdep_stopped",
					subscriptionSelection: { mode: "new" },
					selection: wallet,
					idempotencyKey: "key-refused",
					quote: walletQuote,
				})
				.catch((caught: unknown) => caught);
			expect(error).toMatchObject({
				status,
				code,
				serverDateMs: Date.parse("2026-10-16T00:30:00Z"),
			});
			expect(hostedCheckoutSends(error)).toBe(1);
		}
		expect(sends).toBe(2);
	});

	const planOperation = (state: string, done: boolean) => ({
		name: "operations/op-1",
		metadata: {
			"@type": "type.googleapis.com/clawdi.v2.DeploymentOperationMetadata",
			deploymentId: "hdep_stopped",
			verb: "plan_change",
			planChange: {
				"@type": "type.googleapis.com/clawdi.v2.ComputePlanChangeProgress",
				operationId: "op-1",
				subscriptionId: 7,
				fundingSource: "wallet",
				changeKind: "immediate_upgrade",
				billingEffect: "immediate_proration",
				sourcePlanSlug: "compute_basic",
				targetPlanSlug: "compute_performance",
				targetBillingTermMonths: 1,
				state,
				effectiveAt: "2026-10-16T00:00:00Z",
			},
		},
		done,
		response: done
			? {
					"@type": "type.googleapis.com/clawdi.v2.DeploymentOperationResponse",
					deployment: { id: "hdep_stopped" },
				}
			: null,
	});

	test("accepts a plan change keyed by the quote's operation_id, then polls it to a result", async () => {
		const sent: { method: string; url: string; key: string | null }[] = [];
		const replies = [
			planOperation("wallet_debit_pending", false),
			planOperation("awaiting_projection", false),
			planOperation("complete", true),
		];
		const client = createHostedComputeClient({
			...options,
			fetch: async (request) => {
				sent.push({
					method: request.method,
					url: request.url,
					key: request.headers.get("Idempotency-Key"),
				});
				return Response.json(replies.shift(), { status: request.method === "POST" ? 202 : 200 });
			},
		});
		const accepted: string[] = [];
		const outcome = await client.changePlan(
			{ operation_id: "op-1" },
			{ onAccepted: (name) => accepted.push(name), sleep: async () => undefined },
		);
		expect(outcome).toMatchObject({ kind: "settled", result: { kind: "complete" } });
		expect(accepted).toEqual(["operations/op-1"]);
		expect(sent).toEqual([
			{
				method: "POST",
				url: "https://compute.example.test/v2/subscription/plan/change",
				key: "op-1",
			},
			{ method: "GET", url: "https://compute.example.test/v2/operations/op-1", key: null },
			{ method: "GET", url: "https://compute.example.test/v2/operations/op-1", key: null },
		]);
	});

	test("reports a still-running change at the poll limit and re-reads it only on Check status", async () => {
		let reads = 0;
		const client = createHostedComputeClient({
			...options,
			fetch: async (request) => {
				if (request.method === "GET") reads++;
				return Response.json(planOperation("awaiting_payment", false));
			},
		});
		await expect(
			client.changePlan({ operation_id: "op-1" }, { pollLimit: 2, sleep: async () => undefined }),
		).resolves.toEqual({ kind: "pending", operationName: "operations/op-1" });
		expect(reads).toBe(2);
		await expect(client.checkPlanChange("operations/op-1")).resolves.toEqual({
			kind: "pending",
			operationName: "operations/op-1",
		});
		expect(reads).toBe(3);
		// Another operation's reading, or one for another quote, is never accepted.
		await expect(client.checkPlanChange("operations/op-2")).rejects.toBeInstanceOf(
			ApiClientResponseError,
		);
		await expect(client.changePlan({ operation_id: "op-2" })).rejects.toBeInstanceOf(
			ApiClientResponseError,
		);
	});
});
