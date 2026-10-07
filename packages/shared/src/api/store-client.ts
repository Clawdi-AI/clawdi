import createClient from "openapi-fetch";
import type { components, paths } from "./deploy.generated";
import {
	ApiClientError,
	type ApiClientOptions,
	ApiClientResponseError,
	createReadTransport,
	readApiBaseUrl,
} from "./read-transport";

export type StoreBootstrap = components["schemas"]["StoreBootstrapResponse"];
export type StorePlatform = paths["/v2/store/bootstrap"]["get"]["parameters"]["query"]["platform"];
export type StorePurchaseAttemptRequest = components["schemas"]["StorePurchaseAttemptRequest"];
export type StorePurchaseAttempt = components["schemas"]["StorePurchaseAttemptResponse"];
export type StorePurchaseConfirmRequest = components["schemas"]["StorePurchaseConfirmRequest"];
export type StorePurchaseConfirmation = components["schemas"]["StorePurchaseConfirmResponse"];
export type StorePurchaseAttemptsQuery =
	paths["/v2/store/purchase-attempts"]["get"]["parameters"]["query"];

const attemptStates = {
	prepared: true,
	awaiting_store_result: true,
	verification_pending: true,
	funding_applied: true,
	canceled: true,
	expired: true,
	rejected: true,
	reconciliation_required: true,
} satisfies Record<StorePurchaseAttempt["state"], true>;

function isAttemptState(value: unknown): boolean {
	return typeof value === "string" && Object.hasOwn(attemptStates, value);
}
function isPlatform(value: unknown): boolean {
	return value === "app_store" || value === "play_store";
}
function isPurpose(value: unknown): boolean {
	return value === "standalone_topup" || value === "deploy_continuation";
}
function isNonemptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}
function isUuid(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value)
	);
}
function isRevision(value: unknown): boolean {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}
function isMoney(value: unknown): boolean {
	return typeof value === "string" && /^(?![-+.]*$)[+-]?0*\d*\.?\d*$/.test(value);
}

function validateBootstrap(result: StoreBootstrap): StoreBootstrap {
	if (
		!result ||
		typeof result.purchases_enabled !== "boolean" ||
		(result.reason != null && typeof result.reason !== "string") ||
		(result.app_user_id != null && !isUuid(result.app_user_id)) ||
		(result.catalogue_revision != null && !isRevision(result.catalogue_revision)) ||
		(result.products != null &&
			(!Array.isArray(result.products) ||
				result.products.some(
					(product) =>
						!product ||
						!isNonemptyString(product.store_product_id) ||
						!isMoney(product.credit_usd) ||
						product.effect !== "wallet_credit",
				))) ||
		(result.wallet != null &&
			(typeof result.wallet.balance_available !== "boolean" ||
				typeof result.wallet.open_debt !== "boolean" ||
				(result.wallet.balance_usd !== null && !isMoney(result.wallet.balance_usd)) ||
				result.wallet.balance_available !== (result.wallet.balance_usd !== null))) ||
		(result.purchases_enabled &&
			(!isUuid(result.app_user_id) ||
				!isRevision(result.catalogue_revision) ||
				result.products == null ||
				result.wallet == null))
	)
		throw new ApiClientResponseError();
	return result;
}

function validateAttempt(result: StorePurchaseAttempt): StorePurchaseAttempt {
	if (
		!result ||
		!isUuid(result.attempt_id) ||
		!isAttemptState(result.state) ||
		typeof result.expires_at !== "string" ||
		!Number.isFinite(Date.parse(result.expires_at)) ||
		!isPlatform(result.platform) ||
		!isPurpose(result.purpose) ||
		!isRevision(result.catalogue_revision) ||
		(result.store_product_id != null && !isNonemptyString(result.store_product_id)) ||
		(result.pending_deploy_request_id != null &&
			!isNonemptyString(result.pending_deploy_request_id)) ||
		(result.transaction_id != null && !isUuid(result.transaction_id))
	)
		throw new ApiClientResponseError();
	return result;
}

function readAttemptId(id: string): string {
	if (!isUuid(id)) throw new ApiClientError(400, "invalid_attempt_id");
	return id;
}

/** Retain the same key and body when explicitly recovering an uncertain creation. */
export function storeIdempotencyHeaders(key: string) {
	if (typeof key !== "string" || !/^[\x21-\x7e]{1,200}$/.test(key))
		throw new ApiClientError(400, "invalid_idempotency_key");
	return { "Idempotency-Key": key };
}

/** Uses ApiClientError.status/code for hosted typed failures; never exposes server details or retries. */
export function createHostedStoreClient(options: ApiClientOptions) {
	const transport = createReadTransport(options);
	const api = createClient<paths>({
		baseUrl: readApiBaseUrl(options.baseUrl, true),
		fetch: transport.fetch,
	});
	return {
		/** A disabled bootstrap may omit identity, catalogue and wallet or return null for them. */
		bootstrap: async (platform: StorePlatform, signal?: AbortSignal): Promise<StoreBootstrap> => {
			if (!isPlatform(platform)) throw new ApiClientError(400, "invalid_store_platform");
			return validateBootstrap(
				await transport.read(
					(init) => api.GET("/v2/store/bootstrap", { ...init, params: { query: { platform } } }),
					signal,
				),
			);
		},
		/** RevenueCat Paywalls selects the package; the server binds its product during confirmation. */
		createPurchaseAttempt: async (
			body: StorePurchaseAttemptRequest,
			key: string,
			signal?: AbortSignal,
		): Promise<StorePurchaseAttempt> => {
			const header = storeIdempotencyHeaders(key);
			if (
				!body ||
				!isPlatform(body.platform) ||
				!isPurpose(body.purpose) ||
				!isRevision(body.catalogue_revision) ||
				(body.pending_deploy_request_id != null &&
					(typeof body.pending_deploy_request_id !== "string" ||
						body.pending_deploy_request_id.length < 1 ||
						body.pending_deploy_request_id.length > 191))
			)
				throw new ApiClientError(400, "invalid_store_attempt_request");
			const request: StorePurchaseAttemptRequest = {
				platform: body.platform,
				catalogue_revision: body.catalogue_revision,
				purpose: body.purpose,
				pending_deploy_request_id: body.pending_deploy_request_id,
			};
			const result = validateAttempt(
				await transport.read(
					(init) =>
						api.POST("/v2/store/purchase-attempts", {
							...init,
							params: { header },
							body: request,
						}),
					signal,
				),
			);
			if (
				result.platform !== request.platform ||
				result.purpose !== request.purpose ||
				result.catalogue_revision !== request.catalogue_revision ||
				(result.pending_deploy_request_id ?? null) !== (request.pending_deploy_request_id ?? null)
			)
				throw new ApiClientResponseError();
			return result;
		},
		/** The transaction ID is a hint; only the returned server state acknowledges funding. */
		confirmPurchaseAttempt: async (
			id: string,
			body: StorePurchaseConfirmRequest = {},
			signal?: AbortSignal,
		): Promise<StorePurchaseConfirmation> => {
			const params = { path: { attempt_id: readAttemptId(id) } };
			if (
				!body ||
				(body.store_transaction_id != null &&
					(typeof body.store_transaction_id !== "string" ||
						body.store_transaction_id.length < 1 ||
						body.store_transaction_id.length > 255))
			)
				throw new ApiClientError(400, "invalid_store_confirmation_request");
			const result = await transport.read(
				(init) =>
					api.POST("/v2/store/purchase-attempts/{attempt_id}/confirm", {
						...init,
						params,
						body: { store_transaction_id: body.store_transaction_id },
					}),
				signal,
			);
			if (
				!result ||
				!isAttemptState(result.state) ||
				!isNonemptyString(result.correlation_id) ||
				(result.credit_usd != null && !isMoney(result.credit_usd)) ||
				(result.wallet_balance_usd != null && !isMoney(result.wallet_balance_usd)) ||
				(result.code != null &&
					result.code !== "reconciliation_pending" &&
					!isAttemptState(result.code))
			)
				throw new ApiClientResponseError();
			return result;
		},
		getPurchaseAttempt: async (id: string, signal?: AbortSignal): Promise<StorePurchaseAttempt> => {
			const params = { path: { attempt_id: readAttemptId(id) } };
			const result = validateAttempt(
				await transport.read(
					(init) => api.GET("/v2/store/purchase-attempts/{attempt_id}", { ...init, params }),
					signal,
				),
			);
			if (result.attempt_id.toLowerCase() !== id.toLowerCase()) throw new ApiClientResponseError();
			return result;
		},
		listPurchaseAttempts: async (
			query?: StorePurchaseAttemptsQuery,
			signal?: AbortSignal,
		): Promise<StorePurchaseAttempt[]> => {
			if (query?.state != null && query.state !== "pending")
				throw new ApiClientError(400, "invalid_store_attempt_query");
			const result = await transport.read(
				(init) => api.GET("/v2/store/purchase-attempts", { ...init, params: { query } }),
				signal,
			);
			if (!Array.isArray(result)) throw new ApiClientResponseError();
			return result.map(validateAttempt);
		},
	};
}

export type HostedStoreClient = ReturnType<typeof createHostedStoreClient>;
