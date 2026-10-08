import { describe, expect, test } from "bun:test";
import { ApiClientError, ApiClientResponseError } from "./read-transport";
import {
	createHostedStoreClient,
	readStoreErrorCode,
	type StoreBootstrap,
	type StoreComputeReconcileResponse,
	StoreErrorCode,
	type StorePurchaseAttempt,
	type StorePurchaseAttemptRequest,
	storeIdempotencyHeaders,
} from "./store-client";

const options = {
	baseUrl: "https://hosted.example.test/v2/",
	getToken: async () => "fixture-token",
};
const request: StorePurchaseAttemptRequest = {
	platform: "app_store",
	catalogue_revision: 1,
	purpose: "deploy_continuation",
	pending_deploy_request_id: "deploy &+/request",
};
const attempt: StorePurchaseAttempt = {
	attempt_id: "e0fbff7e-640a-4ff1-9bc3-c0510d471f3d",
	state: "prepared",
	expires_at: "2026-10-08T12:00:00Z",
	store_product_id: null,
	transaction_id: null,
	...request,
};
const bootstrap: StoreBootstrap = {
	purchases_enabled: true,
	compute_subscriptions_enabled: true,
	app_user_id: "aa0fb0f2-be21-4a21-9741-458a8ea0a6af",
	catalogue_revision: 1,
	products: [
		{ store_product_id: "ai.clawdi.app.credits.10", credit_usd: "10.00", effect: "wallet_credit" },
	],
	wallet: { balance_usd: "12.50", balance_available: true, open_debt: false },
};

const computeAttemptRequest: StorePurchaseAttemptRequest = {
	platform: "play_store",
	catalogue_revision: 7,
	purpose: "compute_subscription",
	store_product_id: "ai.clawdi.app.compute:performance-monthly",
	target_contract_id: attempt.attempt_id.toUpperCase(),
};

const computeAttempt: StorePurchaseAttempt = {
	...attempt,
	...computeAttemptRequest,
	catalogue_revision: 7,
	pending_deploy_request_id: null,
	target_contract_id: attempt.attempt_id,
	requested_store_product_id: computeAttemptRequest.store_product_id,
	replacement_mode: "DEFERRED",
};

describe("Hosted store client", () => {
	test("uses authenticated store routes, exact idempotency headers and product-free attempt creation", async () => {
		const requests: {
			method: string;
			path: string;
			query: string;
			key: string | null;
			body: unknown;
		}[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(incoming) {
				expect(incoming.headers.get("Authorization")).toBe("Bearer fixture-token");
				const url = new URL(incoming.url);
				requests.push({
					method: incoming.method,
					path: url.pathname,
					query: url.search,
					key: incoming.headers.get("Idempotency-Key"),
					body: incoming.method === "POST" ? await incoming.json() : null,
				});
				if (url.pathname.endsWith("bootstrap")) return Response.json(bootstrap);
				if (url.pathname.endsWith("confirm"))
					return Response.json({
						state: "verification_pending",
						code: "reconciliation_pending",
						correlation_id: "correlation-fixture",
					});
				if (incoming.method === "GET" && url.pathname.endsWith("purchase-attempts"))
					return Response.json([attempt]);
				return Response.json(attempt);
			},
		});
		try {
			const client = createHostedStoreClient({
				...options,
				baseUrl: `${server.url.href}v2/`,
				fetch,
			});
			expect(await client.bootstrap("play_store")).toEqual(bootstrap);
			// Runtime callers cannot inject a product picked outside RevenueCat Paywalls.
			const input = { ...request, store_product_id: "ignored-product" };
			expect(await client.createPurchaseAttempt(input, "attempt-key")).toEqual(attempt);
			expect(await client.getPurchaseAttempt(attempt.attempt_id)).toEqual(attempt);
			expect(await client.listPurchaseAttempts({ state: "pending" })).toEqual([attempt]);
			await client.listPurchaseAttempts();
			const hint = "store &+/transaction";
			expect(
				await client.confirmPurchaseAttempt(attempt.attempt_id, { store_transaction_id: hint }),
			).toMatchObject({ state: "verification_pending", code: "reconciliation_pending" });
			await client.confirmPurchaseAttempt(attempt.attempt_id);
			expect(requests).toEqual([
				{
					method: "GET",
					path: "/v2/store/bootstrap",
					query: "?platform=play_store",
					key: null,
					body: null,
				},
				{
					method: "POST",
					path: "/v2/store/purchase-attempts",
					query: "",
					key: "attempt-key",
					body: request,
				},
				{
					method: "GET",
					path: `/v2/store/purchase-attempts/${attempt.attempt_id}`,
					query: "",
					key: null,
					body: null,
				},
				{
					method: "GET",
					path: "/v2/store/purchase-attempts",
					query: "?state=pending",
					key: null,
					body: null,
				},
				{ method: "GET", path: "/v2/store/purchase-attempts", query: "", key: null, body: null },
				{
					method: "POST",
					path: `/v2/store/purchase-attempts/${attempt.attempt_id}/confirm`,
					query: "",
					key: null,
					body: { store_transaction_id: hint },
				},
				{
					method: "POST",
					path: `/v2/store/purchase-attempts/${attempt.attempt_id}/confirm`,
					query: "",
					key: null,
					body: {},
				},
			]);
		} finally {
			server.stop(true);
		}
	});

	test("creates a standalone top-up without a pending deployment or bound product", async () => {
		const request: StorePurchaseAttemptRequest = {
			platform: "play_store",
			catalogue_revision: 1,
			purpose: "standalone_topup",
		};
		for (const body of [request, { ...request, pending_deploy_request_id: null }]) {
			const client = createHostedStoreClient({
				...options,
				fetch: async (incoming) => {
					expect(await incoming.json()).toEqual(body);
					return Response.json({ ...attempt, ...body, pending_deploy_request_id: null });
				},
			});
			expect(await client.createPurchaseAttempt(body, "topup-key")).toMatchObject({
				purpose: "standalone_topup",
				pending_deploy_request_id: null,
				store_product_id: null,
			});
		}
	});

	test("creates compute attempts with one target and exposes the server replacement mode", async () => {
		const requests: { key: string | null; body: unknown }[] = [];
		const client = createHostedStoreClient({
			...options,
			fetch: async (incoming) => {
				requests.push({
					key: incoming.headers.get("Idempotency-Key"),
					body: await incoming.json(),
				});
				return Response.json(computeAttempt);
			},
		});

		expect(await client.createPurchaseAttempt(computeAttemptRequest, "compute-key")).toEqual(
			computeAttempt,
		);
		expect(requests).toEqual([
			{
				key: "compute-key",
				body: computeAttemptRequest,
			},
		]);
	});

	test("rejects compute attempts when the server echoes a different target or product", async () => {
		const cases: {
			body: StorePurchaseAttemptRequest;
			response: StorePurchaseAttempt;
		}[] = [
			{
				body: computeAttemptRequest,
				response: {
					...computeAttempt,
					requested_store_product_id: "ai.clawdi.app.compute:basic-monthly",
				},
			},
			{
				body: computeAttemptRequest,
				response: {
					...computeAttempt,
					target_contract_id: "f1fbff7e-640a-4ff1-9bc3-c0510d471f3d",
				},
			},
			{
				body: {
					...computeAttemptRequest,
					target_contract_id: null,
					target_deployment_id: "hdep_target",
				},
				response: {
					...computeAttempt,
					target_contract_id: null,
					target_deployment_id: "hdep_other",
				},
			},
		];
		for (const { body, response } of cases) {
			const client = createHostedStoreClient({
				...options,
				fetch: async () => Response.json(response),
			});
			await expect(client.createPurchaseAttempt(body, "compute-key")).rejects.toBeInstanceOf(
				ApiClientResponseError,
			);
		}
	});

	test("requires exactly one compute target before auth or network", async () => {
		let tokens = 0;
		const client = createHostedStoreClient({
			...options,
			getToken: async () => {
				tokens++;
				return "fixture";
			},
			fetch: async () => {
				throw new Error("Unexpected network");
			},
		});
		for (const patch of [
			{ pending_deploy_request_id: null, target_contract_id: null },
			{
				pending_deploy_request_id: "deploy-request-7",
				target_deployment_id: "hdep_target",
				target_contract_id: null,
			},
			{
				pending_deploy_request_id: "deploy-request-7",
				target_contract_id: attempt.attempt_id,
			},
			{
				pending_deploy_request_id: null,
				target_deployment_id: "hdep_target",
				target_contract_id: attempt.attempt_id,
			},
			{ pending_deploy_request_id: null, target_contract_id: "not-a-uuid" },
		]) {
			await expect(
				client.createPurchaseAttempt({ ...computeAttemptRequest, ...patch }, "compute-key"),
			).rejects.toMatchObject({
				status: 400,
				code: "invalid_compute_subscription_attempt_request",
			});
		}
		expect(tokens).toBe(0);
	});

	test("reconciles mixed owned and foreign subscriptions without client-side aggregation", async () => {
		const response: StoreComputeReconcileResponse = {
			code: "reconciled",
			compute_slot: {
				available: false,
				contract_id: attempt.attempt_id,
				compute_subscription_id: 42,
				agent_id: "hdep_bound",
				store_management: {
					contract_id: attempt.attempt_id,
					provider: "play_store",
					product_id: "ai.clawdi.app.compute:basic-monthly",
					management_url:
						"https://play.google.com/store/account/subscriptions?sku=ai.clawdi.app.compute&package=ai.clawdi.app",
					auto_renews: true,
					renews_or_ends_at: "2026-10-08T12:00:00Z",
					state: "grace",
				},
			},
			results: [
				{
					subscription_id: "owned-subscription",
					contract_id: attempt.attempt_id,
					code: "reconciled",
				},
				{
					subscription_id: "foreign-subscription",
					contract_id: null,
					code: "owned_by_other_account",
				},
			],
		};
		const requests: { method: string; path: string; body: unknown }[] = [];
		const client = createHostedStoreClient({
			...options,
			fetch: async (incoming) => {
				requests.push({
					method: incoming.method,
					path: new URL(incoming.url).pathname,
					body:
						incoming.method === "POST" && incoming.headers.has("content-type")
							? await incoming.json()
							: null,
				});
				return Response.json(response);
			},
		});
		expect(await client.reconcileComputeSubscriptions()).toEqual(response);
		expect(requests).toEqual([
			{ method: "POST", path: "/v2/store/compute-subscriptions/reconcile", body: null },
		]);
		const management = response.compute_slot?.store_management;
		if (!management) throw new Error("Missing management fixture");
		for (const contractId of [undefined, null, "not-a-uuid", 42]) {
			const invalid = createHostedStoreClient({
				...options,
				fetch: async () =>
					Response.json({
						...response,
						compute_slot: {
							...response.compute_slot,
							store_management: { ...management, contract_id: contractId },
						},
					}),
			});
			await expect(invalid.reconcileComputeSubscriptions()).rejects.toBeInstanceOf(
				ApiClientResponseError,
			);
		}
	});

	test("accepts disabled bootstrap with omitted or null identity and unavailable wallet balance", async () => {
		for (const response of [
			{
				purchases_enabled: false,
				compute_subscriptions_enabled: false,
				reason: "store_purchases_disabled",
			},
			{
				purchases_enabled: false,
				compute_subscriptions_enabled: false,
				reason: "store_purchases_disabled",
				app_user_id: null,
				catalogue_revision: null,
				products: null,
				wallet: null,
			},
			{ ...bootstrap, wallet: { balance_usd: null, balance_available: false, open_debt: true } },
		]) {
			const client = createHostedStoreClient({
				...options,
				fetch: async () => Response.json(response),
			});
			expect(await client.bootstrap("app_store")).toEqual(response);
		}
	});

	test("rejects enabled bootstrap without a valid RevenueCat identity or complete catalogue", async () => {
		for (const response of [
			null,
			{},
			{ purchases_enabled: "false" },
			{ ...bootstrap, app_user_id: null },
			{ ...bootstrap, app_user_id: "anonymous-id" },
			{ ...bootstrap, catalogue_revision: null },
			{ ...bootstrap, products: null },
			{ ...bootstrap, products: [null] },
			{ ...bootstrap, wallet: null },
			{ ...bootstrap, wallet: { balance_usd: null, balance_available: true, open_debt: false } },
		]) {
			const client = createHostedStoreClient({
				...options,
				fetch: async () => Response.json(response),
			});
			await expect(client.bootstrap("app_store")).rejects.toBeInstanceOf(ApiClientResponseError);
		}
	});

	test("validates attempt identity and request correlation before accepting creation or recovery", async () => {
		for (const patch of [
			{ platform: "play_store" },
			{ purpose: "standalone_topup" },
			{ catalogue_revision: 2 },
			{ pending_deploy_request_id: "another-deploy" },
			{ state: "invented-state" },
			{ expires_at: "invalid-date" },
			{ attempt_id: "not-a-uuid" },
		]) {
			const client = createHostedStoreClient({
				...options,
				fetch: async () => Response.json({ ...attempt, ...patch }),
			});
			await expect(client.createPurchaseAttempt(request, "key")).rejects.toBeInstanceOf(
				ApiClientResponseError,
			);
		}
		const client = createHostedStoreClient({
			...options,
			fetch: async () => Response.json({ ...attempt, attempt_id: bootstrap.app_user_id }),
		});
		await expect(client.getPurchaseAttempt(attempt.attempt_id)).rejects.toBeInstanceOf(
			ApiClientResponseError,
		);
		for (const response of [{ attempts: [] }, [null], [{ ...attempt, state: "unknown" }]]) {
			const recovery = createHostedStoreClient({
				...options,
				fetch: async () => Response.json(response),
			});
			await expect(recovery.listPurchaseAttempts()).rejects.toBeInstanceOf(ApiClientResponseError);
		}
	});

	test("rejects malformed confirm acknowledgements without interpreting the hint as success", async () => {
		for (const response of [
			{ state: "funding_applied" },
			{ state: "unknown", correlation_id: "fixture" },
			{ state: "verification_pending", correlation_id: "" },
			{ state: "verification_pending", correlation_id: "fixture", code: "unknown" },
			{ state: "funding_applied", correlation_id: "fixture", credit_usd: 10 },
		]) {
			const client = createHostedStoreClient({
				...options,
				fetch: async () => Response.json(response),
			});
			await expect(client.confirmPurchaseAttempt(attempt.attempt_id)).rejects.toBeInstanceOf(
				ApiClientResponseError,
			);
		}
	});

	test("preserves hosted typed error codes and safe categories, without automatic retries", async () => {
		for (const [status, code, category] of [
			[403, "store_purchases_disabled", "forbidden"],
			[403, "store_identity_tombstoned", "forbidden"],
			[409, "catalogue_revision_stale", "conflict"],
			[409, "idempotency_key_conflict", "conflict"],
			[409, "pending_deploy_request_not_allowed", "conflict"],
			[409, "open_refund_debt", "conflict"],
			[404, "store_attempt_not_found", "not_found"],
			[503, "store_configuration_missing", "server"],
			[503, "store_attempt_unavailable", "server"],
			[503, "store_identity_unavailable", "server"],
			[409, "store_product_unapproved", "conflict"],
			[409, "store_environment_held", "conflict"],
			[429, null, "rate_limited"],
		] as const) {
			let sends = 0;
			const client = createHostedStoreClient({
				...options,
				fetch: async () => {
					sends++;
					return Response.json({ detail: { code, message: "private server detail" } }, { status });
				},
			});
			for (const action of [
				() => client.bootstrap("app_store"),
				() => client.createPurchaseAttempt(request, "same-key"),
				() => client.confirmPurchaseAttempt(attempt.attempt_id),
				() => client.getPurchaseAttempt(attempt.attempt_id),
				() => client.listPurchaseAttempts(),
				() => client.reconcileComputeSubscriptions(),
			]) {
				try {
					await action();
					throw new Error("Expected rejection");
				} catch (error) {
					expect(error).toBeInstanceOf(ApiClientError);
					expect(error).toMatchObject({ status, code, category });
					expect(readStoreErrorCode(error)).toBe(code);
					if (!(error instanceof ApiClientError)) throw error;
					expect(error.message).not.toContain("private server detail");
				}
			}
			expect(sends).toBe(6);
		}
	});

	test("classifies server store errors and holds while preserving unknown and unrelated errors", () => {
		for (const code of [
			StoreErrorCode.store_slot_in_use,
			StoreErrorCode.store_purchases_disabled,
			StoreErrorCode.catalogue_revision_stale,
			StoreErrorCode.store_identity_tombstoned,
			StoreErrorCode.store_transfer_held,
			StoreErrorCode.store_family_share_held,
			StoreErrorCode.store_configuration_invalid,
		]) {
			const error = new ApiClientError(409, code);
			const result: StoreErrorCode | null = readStoreErrorCode(error);
			expect(result).toBe(code);
		}
		for (const error of [
			new ApiClientError(401),
			new ApiClientError(409, "future_store_code"),
			new ApiClientError(400, "invalid_store_platform"),
			new ApiClientError(409, "toString"),
			new ApiClientError(409, "__proto__"),
			new Error("store_purchases_disabled"),
			{ code: "store_purchases_disabled" },
			null,
			undefined,
		])
			expect(readStoreErrorCode(error)).toBeNull();
	});

	test("rejects standalone top-ups with pending deployment context before auth or network", async () => {
		let tokens = 0;
		let sends = 0;
		const client = createHostedStoreClient({
			...options,
			getToken: async () => {
				tokens++;
				return "fixture";
			},
			fetch: async () => {
				sends++;
				throw new Error("Unexpected network");
			},
		});
		await expect(
			client.createPurchaseAttempt({ ...request, purpose: "standalone_topup" }, "topup-key"),
		).rejects.toMatchObject({
			status: 409,
			code: StoreErrorCode.pending_deploy_request_not_allowed,
			category: "conflict",
		});
		expect(tokens).toBe(0);
		expect(sends).toBe(0);
	});

	test("rejects invalid keys and inputs before acquiring auth or sending requests", async () => {
		let tokens = 0;
		const client = createHostedStoreClient({
			...options,
			getToken: async () => {
				tokens++;
				return "fixture";
			},
			fetch: async () => {
				throw new Error("Unexpected network");
			},
		});
		for (const key of ["", "bad key", "key\n", "é", "a".repeat(201)])
			await expect(client.createPurchaseAttempt(request, key)).rejects.toMatchObject({
				status: 400,
				code: "invalid_idempotency_key",
			});
		expect(storeIdempotencyHeaders("a".repeat(200))["Idempotency-Key"]).toHaveLength(200);
		await expect(
			client.createPurchaseAttempt({ ...request, catalogue_revision: 0 }, "key"),
		).rejects.toMatchObject({ status: 400 });
		await expect(
			client.createPurchaseAttempt(
				{ ...request, pending_deploy_request_id: "a".repeat(192) },
				"key",
			),
		).rejects.toMatchObject({ status: 400 });
		await expect(client.getPurchaseAttempt("../another?attempt")).rejects.toMatchObject({
			status: 400,
		});
		await expect(
			client.confirmPurchaseAttempt(attempt.attempt_id, { store_transaction_id: "" }),
		).rejects.toMatchObject({ status: 400 });
		expect(tokens).toBe(0);
	});

	test("bounds pending mutations and preserves the same idempotency key for explicit recovery", async () => {
		const keys: (string | null)[] = [];
		const client = createHostedStoreClient({
			...options,
			timeoutMs: 10,
			fetch: async (incoming) => {
				keys.push(incoming.headers.get("Idempotency-Key"));
				if (keys.length === 1)
					return new Promise<Response>((_resolve, reject) => {
						incoming.signal.addEventListener("abort", () => reject(new Error("Aborted")), {
							once: true,
						});
					});
				return Response.json(attempt);
			},
		});
		await expect(client.createPurchaseAttempt(request, "durable-key")).rejects.toMatchObject({
			name: "ApiClientNetworkError",
			kind: "timeout",
		});
		expect(keys).toEqual(["durable-key"]);
		expect(await client.createPurchaseAttempt(request, "durable-key")).toEqual(attempt);
		expect(keys).toEqual(["durable-key", "durable-key"]);
	});
});
