import createClient from "openapi-fetch";
import type { paths as DeployPaths } from "./deploy.generated";
import {
	type HostedDeployRequest,
	type HostedDeploySubscriptionQuoteRequest,
	isHostedDeployComputePlan,
} from "./deploy-wizard";
import {
	ApiClientError,
	type ApiClientOptions,
	ApiClientResponseError,
	createReadTransport,
	readApiBaseUrl,
} from "./read-transport";

export type ComputeSubscriptionsQuery =
	DeployPaths["/v2/subscriptions"]["get"]["parameters"]["query"];
export type ComputeReusableSubscriptionsQuery =
	DeployPaths["/v2/subscriptions/reusable"]["get"]["parameters"]["query"];
export type ComputeWalletTransactionsQuery =
	DeployPaths["/v2/wallet/transactions"]["get"]["parameters"]["query"];
export type ComputeUsageQuery = DeployPaths["/v2/usage"]["get"]["parameters"]["query"];

export function createHostedComputeClient(options: ApiClientOptions) {
	const transport = createReadTransport(options);
	const api = createClient<DeployPaths>({
		baseUrl: readApiBaseUrl(options.baseUrl, true),
		fetch: transport.fetch,
	});
	/** Admission consumes an existing entitlement; it never initiates checkout or a Wallet debit. */
	const createEntitledDeployment = async (
		body: HostedDeployRequest,
		idempotencyKey: string,
		signal?: AbortSignal,
	) => {
		if (
			typeof idempotencyKey !== "string" ||
			idempotencyKey.length < 1 ||
			idempotencyKey.length > 191 ||
			/[^\x21-\x7e]/.test(idempotencyKey)
		) {
			throw new ApiClientError(400, "invalid_idempotency_key");
		}
		if (!isHostedDeployComputePlan(body?.compute_plan_slug))
			throw new ApiClientError(400, "invalid_compute_plan");
		if (body.deploy_request_id != null && body.deploy_request_id !== idempotencyKey)
			throw new ApiClientError(409, "deploy_request_id_mismatch");
		return transport.read(
			(init) =>
				api.POST("/v2/deployments", {
					...init,
					body,
					params: { header: { "Idempotency-Key": idempotencyKey } },
				}),
			signal,
		);
	};
	return {
		/** Starts durable account termination, including hosted resources and Clerk identity.
		 * A 204 acknowledges the request; asynchronous cleanup is not proven complete.
		 * Never automatically retry a timeout or infer deletion from a later 401/403.
		 */
		deleteAccount: (signal?: AbortSignal): Promise<null> =>
			transport.read(async (init) => {
				const result = await api.DELETE("/v1/me", init);
				return { ...result, data: result.response.status === 204 ? null : undefined };
			}, signal),
		/**
		 * Basic/Performance admission against existing server-selected entitlement.
		 * Reads are advisory: the server decides availability and does not buy missing capacity.
		 * No subscription-ID selection exists in this wire contract. Preserve request/key on uncertainty.
		 */
		createEntitledDeployment,
		/** Ownership protection only; this does not expose legacy product actions. */
		getLegacyAgentIds: async (signal?: AbortSignal) => {
			const result = await transport.read(
				(init) => api.GET("/v1/agent-environments", init),
				signal,
			);
			if (
				!Array.isArray(result?.environment_ids) ||
				result.environment_ids.some((id) => typeof id !== "string" || !id || id !== id.trim())
			)
				throw new ApiClientResponseError();
			return result.environment_ids;
		},
		getProductCapabilities: async (signal?: AbortSignal) => {
			const profile = await transport.read((init) => api.GET("/v1/me", init), signal);
			const capabilities = profile?.capabilities;
			if (
				typeof capabilities !== "object" ||
				capabilities === null ||
				typeof capabilities.can_use_v1 !== "boolean" ||
				typeof capabilities.can_use_v2 !== "boolean" ||
				typeof capabilities.can_create_v1_deployment !== "boolean"
			) {
				throw new ApiClientResponseError();
			}
			return capabilities;
		},
		listPlans: (signal?: AbortSignal) =>
			transport.read((init) => api.GET("/v2/subscription/plans", init), signal),
		getManagedModels: (signal?: AbortSignal) =>
			transport.read((init) => api.GET("/v2/ai-providers/managed/models", init), signal),
		getWallet: (signal?: AbortSignal) =>
			transport.read((init) => api.GET("/v2/wallet", init), signal),
		getWalletPaymentMethods: (signal?: AbortSignal) =>
			transport.read((init) => api.GET("/v2/wallet/payment-methods", init), signal),
		getSubscriptions: (query?: ComputeSubscriptionsQuery, signal?: AbortSignal) =>
			transport.read(
				(init) => api.GET("/v2/subscriptions", { ...init, params: { query } }),
				signal,
			),
		getReusableSubscriptions: (query?: ComputeReusableSubscriptionsQuery, signal?: AbortSignal) =>
			transport.read(
				(init) => api.GET("/v2/subscriptions/reusable", { ...init, params: { query } }),
				signal,
			),
		getIncludedBasicAvailability: (signal?: AbortSignal) =>
			transport.read((init) => api.GET("/v2/subscriptions/included-basic", init), signal),
		getWalletTransactions: (query?: ComputeWalletTransactionsQuery, signal?: AbortSignal) =>
			transport.read(
				(init) => api.GET("/v2/wallet/transactions", { ...init, params: { query } }),
				signal,
			),
		getUsage: (query?: ComputeUsageQuery, signal?: AbortSignal) =>
			transport.read((init) => api.GET("/v2/usage", { ...init, params: { query } }), signal),
		/**
		 * Explicitly requested preview: no purchase or debit. The server may initialize
		 * customer/wallet profiles and commit, so this is not a pure read operation.
		 */
		quoteSubscription: (body: HostedDeploySubscriptionQuoteRequest, signal?: AbortSignal) =>
			transport.read((init) => api.POST("/v2/subscription/quote", { ...init, body }), signal),
		/**
		 * Basic-only deployment admission, without purchase or debit. The name does not
		 * guarantee Included entitlement selection for regular users: the server may
		 * select an existing paid entitlement and remains the final eligibility authority.
		 * Creation keys contain 1-191 visible ASCII characters. A supplied request ID
		 * must equal the key, which is also the canonical ID for by-request recovery.
		 * Never automatically retry; callers retain the key to reconcile uncertain results.
		 */
		createIncludedDeployment: async (
			body: HostedDeployRequest,
			idempotencyKey: string,
			signal?: AbortSignal,
		) => {
			if (body?.compute_plan_slug !== "compute_basic") {
				throw new ApiClientError(400, "compute_basic_required");
			}
			return createEntitledDeployment(body, idempotencyKey, signal);
		},
	};
}

export type HostedComputeClient = ReturnType<typeof createHostedComputeClient>;
