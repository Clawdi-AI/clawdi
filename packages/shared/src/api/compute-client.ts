import createClient from "openapi-fetch";
import type { components as DeployComponents, paths as DeployPaths } from "./deploy.generated";
import {
	buildHostedDeployCheckoutRequest,
	type HostedDeployCheckoutRequest,
	type HostedDeployRequest,
	type HostedDeploySubscriptionQuote,
	type HostedDeploySubscriptionQuoteRequest,
	type HostedDeploySubscriptionSelection,
	isHostedDeployComputePlan,
} from "./deploy-wizard";
import {
	ApiClientError,
	ApiClientNetworkError,
	type ApiClientOptions,
	ApiClientResponseError,
	createReadTransport,
	readApiBaseUrl,
	readResourceId,
} from "./read-transport";
import { HOSTED_CHECKOUT_MAX_ATTEMPTS, hostedCheckoutRetryDelayMs } from "./subscription-create";

function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const cancelled = () => signal?.reason ?? new Error("API request cancelled");
		if (signal?.aborted) {
			reject(cancelled());
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(cancelled());
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, delayMs);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export type ComputeSubscriptionsQuery =
	DeployPaths["/v2/subscriptions"]["get"]["parameters"]["query"];
export type ComputeReusableSubscriptionsQuery =
	DeployPaths["/v2/subscriptions/reusable"]["get"]["parameters"]["query"];
export type ComputeWalletTransactionsQuery =
	DeployPaths["/v2/wallet/transactions"]["get"]["parameters"]["query"];
export type ComputeUsageQuery = DeployPaths["/v2/usage"]["get"]["parameters"]["query"];
export type ComputeSubscriptionTarget =
	DeployComponents["schemas"]["V2ComputeSubscriptionCancelRequest"];
export type AccountNotificationsQuery = NonNullable<
	DeployPaths["/v1/me/notifications"]["get"]["parameters"]["query"]
>;

export function createHostedComputeClient(options: ApiClientOptions) {
	const transport = createReadTransport(options);
	const api = createClient<DeployPaths>({
		baseUrl: readApiBaseUrl(options.baseUrl, true),
		fetch: transport.fetch,
	});
	const validateCreation = (body: HostedDeployRequest, idempotencyKey: string) => {
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
	};
	/** Admission consumes an existing entitlement; it never initiates checkout or a Wallet debit. */
	const createEntitledDeployment = async (
		body: HostedDeployRequest,
		idempotencyKey: string,
		signal?: AbortSignal,
		options?: { computeSource?: "store" },
	) => {
		validateCreation(body, idempotencyKey);
		return transport.read(
			(init) =>
				api.POST("/v2/deployments", {
					...init,
					body: options?.computeSource ? { ...body, compute_source: options.computeSource } : body,
					params: { header: { "Idempotency-Key": idempotencyKey } },
				}),
			signal,
		);
	};
	/**
	 * Card and Wallet subscription activation for a new Agent; a checkout session is never
	 * valid here. Like Web's checkout transport, a transport failure or a short 409/503
	 * Retry-After repeats the identical request with the same key, three sends at most.
	 */
	const activateSubscription = async (
		body: HostedDeployCheckoutRequest,
		idempotencyKey: string,
		signal?: AbortSignal,
	) => {
		for (let attempt = 1; ; attempt++) {
			let result: Awaited<ReturnType<typeof sendCheckout>>;
			try {
				result = await sendCheckout(body, idempotencyKey, signal);
			} catch (error) {
				if (attempt >= HOSTED_CHECKOUT_MAX_ATTEMPTS || signal?.aborted) throw error;
				if (error instanceof ApiClientNetworkError) continue;
				const delay =
					error instanceof ApiClientError
						? hostedCheckoutRetryDelayMs(error.status, error.retryAfterMs)
						: null;
				if (delay === null) throw error;
				await waitForRetry(delay, signal);
				continue;
			}
			if (result?.flow_type !== "subscription_activation") throw new ApiClientResponseError();
			return result;
		}
	};
	const sendCheckout = (
		body: HostedDeployCheckoutRequest,
		idempotencyKey: string,
		signal?: AbortSignal,
	) =>
		transport.read(
			(init) =>
				api.POST("/v2/subscription/checkout", {
					...init,
					body,
					params: { header: { "Idempotency-Key": idempotencyKey } },
				}),
			signal,
		);
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
		 * This wire contract selects no subscription ID; `assignReusableSubscription` picks one.
		 * Preserve request/key on uncertainty.
		 */
		createEntitledDeployment,
		/**
		 * Assigns one exact reusable card or Wallet subscription to a new Agent through the
		 * endpoint Web uses for `subscription_selection.mode = "existing"`. Reuse never starts
		 * a checkout or a debit, so any response other than an activation is rejected.
		 */
		assignReusableSubscription: async (
			body: HostedDeployRequest,
			idempotencyKey: string,
			subscription: HostedDeploySubscriptionSelection & { subscriptionId: string },
			signal?: AbortSignal,
		) => {
			validateCreation(body, idempotencyKey);
			if (subscription.planSlug !== body.compute_plan_slug)
				throw new ApiClientError(409, "subscription_plan_mismatch");
			return activateSubscription(
				buildHostedDeployCheckoutRequest({
					selection: subscription,
					subscriptionSelection: {
						mode: "existing",
						subscription_id: readResourceId(subscription.subscriptionId),
					},
					target: { kind: "new_deployment", deployRequest: body },
					idempotencyKey,
					quote: null,
					uiMode: "custom",
				}),
				idempotencyKey,
				signal,
			);
		},
		/**
		 * Starts a new Wallet-funded subscription for a new Agent exactly like Web's Wallet
		 * deploy: `subscription_selection.mode = "new"` with the server quote the user
		 * confirmed. Hosted debits at most once per deploy request; the same key, payload and
		 * quote replay the original activation, including Web's automatic same-key retries.
		 */
		createWalletSubscriptionDeployment: async (
			body: HostedDeployRequest,
			idempotencyKey: string,
			quote: HostedDeploySubscriptionQuote,
			signal?: AbortSignal,
		) => {
			validateCreation(body, idempotencyKey);
			if (quote.funding_source !== "wallet") throw new ApiClientError(400, "wallet_quote_required");
			if (quote.plan_slug !== body.compute_plan_slug)
				throw new ApiClientError(409, "subscription_plan_mismatch");
			return activateSubscription(
				buildHostedDeployCheckoutRequest({
					selection: {
						planSlug: quote.plan_slug,
						billingTermMonths: quote.billing_term_months,
						fundingSource: "wallet",
					},
					subscriptionSelection: { mode: "new" },
					target: { kind: "new_deployment", deployRequest: body },
					idempotencyKey,
					quote,
					uiMode: "custom",
				}),
				idempotencyKey,
				signal,
			);
		},
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
		listNotifications: (query: AccountNotificationsQuery, signal?: AbortSignal) =>
			transport.read(
				(init) => api.GET("/v1/me/notifications", { ...init, params: { query } }),
				signal,
			),
		/** Marks every notification up to and including `upToId` read. */
		markNotificationsRead: (upToId: string, signal?: AbortSignal) =>
			transport.read(
				(init) =>
					api.POST("/v1/me/notifications/read-all", {
						...init,
						body: { up_to_id: readResourceId(upToId) },
					}),
				signal,
			),
		deleteNotification: (id: string, signal?: AbortSignal): Promise<null> =>
			transport.read(async (init) => {
				const result = await api.DELETE("/v1/me/notifications/{notification_id}", {
					...init,
					params: { path: { notification_id: readResourceId(id) } },
				});
				return { ...result, data: result.response.ok ? null : undefined };
			}, signal),
		/**
		 * Card/Wallet subscription commands (Web's subscription actions). None purchases:
		 * cancel stops renewal (or ends a trial), resume restores renewal, and cancelling a
		 * scheduled plan change keeps the current plan. Never retried automatically.
		 */
		cancelSubscription: (body: ComputeSubscriptionTarget, signal?: AbortSignal) =>
			transport.read((init) => api.POST("/v2/subscription/cancel", { ...init, body }), signal),
		resumeSubscription: (body: ComputeSubscriptionTarget, signal?: AbortSignal) =>
			transport.read((init) => api.POST("/v2/subscription/resume", { ...init, body }), signal),
		cancelScheduledPlanChange: (body: ComputeSubscriptionTarget, signal?: AbortSignal) =>
			transport.read(
				(init) => api.POST("/v2/subscription/plan/cancel-scheduled-change", { ...init, body }),
				signal,
			),
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
