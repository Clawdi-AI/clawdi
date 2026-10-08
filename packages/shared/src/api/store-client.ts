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
export type StoreComputeReconcileResponse = components["schemas"]["StoreComputeReconcileResponse"];
export type StoreComputeSlot = components["schemas"]["StoreComputeSlot"];
export type StorePurchaseAttemptsQuery =
	paths["/v2/store/purchase-attempts"]["get"]["parameters"]["query"];

/** Hosted HTTP error codes are not advertised in OpenAPI. Sources: clawdi-hosted
 * origin/main (verified at 1c2e07c01), grouped by their owning file below.
 */
export const StoreErrorCode = {
	// backend/app/v2/store_routes.py: _problem() codes.
	catalogue_revision_stale: "catalogue_revision_stale",
	idempotency_key_conflict: "idempotency_key_conflict",
	invalid_idempotency_key: "invalid_idempotency_key",
	open_refund_debt: "open_refund_debt",
	pending_deploy_request_not_allowed: "pending_deploy_request_not_allowed",
	store_attempt_not_found: "store_attempt_not_found",
	store_attempt_unavailable: "store_attempt_unavailable",
	store_configuration_missing: "store_configuration_missing",
	store_identity_tombstoned: "store_identity_tombstoned",
	store_identity_unavailable: "store_identity_unavailable",
	store_purchases_disabled: "store_purchases_disabled",
	// backend/app/services/webhook_inbox.py: WebhookQuarantineReason.STORE_* hold reasons.
	store_namespace_invalid: "store_namespace_invalid",
	store_replay_conflict: "store_replay_conflict",
	store_identity_invalid: "store_identity_invalid",
	store_product_unapproved: "store_product_unapproved",
	store_quantity_unsupported: "store_quantity_unsupported",
	store_transfer_held: "store_transfer_held",
	store_family_share_held: "store_family_share_held",
	store_subscription_held: "store_subscription_held",
	store_reconciliation_overdue: "store_reconciliation_overdue",
	store_environment_held: "store_environment_held",
	store_attempt_conflict: "store_attempt_conflict",
	store_evidence_not_converged: "store_evidence_not_converged",
	store_configuration_invalid: "store_configuration_invalid",
} as const;
export type StoreErrorCode = (typeof StoreErrorCode)[keyof typeof StoreErrorCode];

/** Unknown future codes and non-API errors remain unclassified. */
export function readStoreErrorCode(error: unknown): StoreErrorCode | null {
	if (!(error instanceof ApiClientError)) return null;
	return Object.values(StoreErrorCode).find((code) => code === error.code) ?? null;
}

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
function isUuidOrNull(value: unknown): boolean {
	return value == null || isUuid(value);
}
function normalizeUuid(value: string | null | undefined): string | null {
	return value?.toLowerCase() ?? null;
}
function isPurpose(value: unknown): boolean {
	return (
		value === "standalone_topup" ||
		value === "deploy_continuation" ||
		value === "compute_subscription"
	);
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

function isStoreProvider(value: unknown): boolean {
	return value === "app_store" || value === "play_store" || value === "test_store";
}

function isStoreManagement(
	value: unknown,
): value is NonNullable<StoreComputeSlot["store_management"]> {
	if (!value || typeof value !== "object") return false;
	const management = value as Record<string, unknown>;
	return (
		isUuid(management.contract_id) &&
		isStoreProvider(management.provider) &&
		isNonemptyString(management.product_id) &&
		(management.management_url == null || isNonemptyString(management.management_url)) &&
		typeof management.auto_renews === "boolean" &&
		(management.renews_or_ends_at == null ||
			(typeof management.renews_or_ends_at === "string" &&
				Number.isFinite(Date.parse(management.renews_or_ends_at)))) &&
		isNonemptyString(management.state)
	);
}

function isComputeSlot(value: unknown): value is StoreComputeSlot {
	if (!value || typeof value !== "object") return false;
	const slot = value as Record<string, unknown>;
	return (
		typeof slot.available === "boolean" &&
		isUuidOrNull(slot.contract_id) &&
		(slot.compute_subscription_id == null ||
			(typeof slot.compute_subscription_id === "number" &&
				Number.isSafeInteger(slot.compute_subscription_id) &&
				slot.compute_subscription_id > 0)) &&
		(slot.agent_id == null ||
			(typeof slot.agent_id === "string" && /^hdep_.+/.test(slot.agent_id))) &&
		(slot.store_management == null || isStoreManagement(slot.store_management))
	);
}

function validateBootstrap(result: StoreBootstrap): StoreBootstrap {
	if (
		!result ||
		typeof result.purchases_enabled !== "boolean" ||
		typeof result.compute_subscriptions_enabled !== "boolean" ||
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
		(result.compute_slot != null && !isComputeSlot(result.compute_slot)) ||
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
		(result.transaction_id != null && !isUuid(result.transaction_id)) ||
		!isUuidOrNull(result.target_contract_id) ||
		(result.target_deployment_id != null &&
			(typeof result.target_deployment_id !== "string" ||
				!/^hdep_.+/.test(result.target_deployment_id))) ||
		(result.requested_store_product_id != null &&
			!isNonemptyString(result.requested_store_product_id)) ||
		(result.replacement_mode != null &&
			result.replacement_mode !== "CHARGE_PRORATED_PRICE" &&
			result.replacement_mode !== "CHARGE_FULL_PRICE" &&
			result.replacement_mode !== "DEFERRED")
	)
		throw new ApiClientResponseError();
	return result;
}

function validateComputeReconcile(
	result: StoreComputeReconcileResponse,
): StoreComputeReconcileResponse {
	if (
		!result ||
		(result.code !== "reconciled" &&
			result.code !== "reconciliation_pending" &&
			result.code !== "owned_by_other_account") ||
		(result.compute_slot != null && !isComputeSlot(result.compute_slot)) ||
		(result.results != null &&
			(!Array.isArray(result.results) ||
				result.results.some(
					(entry) =>
						!entry ||
						(entry.subscription_id != null && !isNonemptyString(entry.subscription_id)) ||
						!isUuidOrNull(entry.contract_id) ||
						(entry.code !== "reconciled" &&
							entry.code !== "reconciliation_pending" &&
							entry.code !== "owned_by_other_account"),
				)))
	)
		throw new ApiClientResponseError();
	return result;
}

function readAttemptId(id: string): string {
	if (!isUuid(id)) throw new ApiClientError(400, "invalid_attempt_id");
	return id;
}

/** M1's durable attempt journal generates and persists keys before creation.
 * This helper only validates/serializes them; recovery retains the same key and body.
 */
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
				(body.store_product_id != null &&
					(typeof body.store_product_id !== "string" ||
						body.store_product_id.length < 1 ||
						body.store_product_id.length > 255)) ||
				(body.pending_deploy_request_id != null &&
					(typeof body.pending_deploy_request_id !== "string" ||
						body.pending_deploy_request_id.length < 1 ||
						body.pending_deploy_request_id.length > 191))
			)
				throw new ApiClientError(400, "invalid_store_attempt_request");
			if (body.purpose === "standalone_topup" && body.pending_deploy_request_id != null)
				throw new ApiClientError(409, StoreErrorCode.pending_deploy_request_not_allowed);
			if (body.purpose === "compute_subscription") {
				const targetCount = [
					body.pending_deploy_request_id,
					body.target_deployment_id,
					body.target_contract_id,
				].filter((value) => value != null).length;
				if (
					!isNonemptyString(body.store_product_id) ||
					!isUuidOrNull(body.target_contract_id) ||
					(body.target_deployment_id != null &&
						(typeof body.target_deployment_id !== "string" ||
							!/^hdep_.+/.test(body.target_deployment_id))) ||
					targetCount !== 1
				)
					throw new ApiClientError(400, "invalid_compute_subscription_attempt_request");
			}
			const request: StorePurchaseAttemptRequest = {
				platform: body.platform,
				catalogue_revision: body.catalogue_revision,
				purpose: body.purpose,
				pending_deploy_request_id: body.pending_deploy_request_id,
				...(body.purpose === "compute_subscription"
					? {
							store_product_id: body.store_product_id,
							target_contract_id: body.target_contract_id,
							target_deployment_id: body.target_deployment_id,
						}
					: {}),
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
				(result.pending_deploy_request_id ?? null) !==
					(request.pending_deploy_request_id ?? null) ||
				(request.purpose === "compute_subscription" &&
					(result.requested_store_product_id ?? result.store_product_id ?? null) !==
						(request.store_product_id ?? null)) ||
				(request.purpose === "compute_subscription" &&
					normalizeUuid(result.target_contract_id) !== normalizeUuid(request.target_contract_id)) ||
				(request.purpose === "compute_subscription" &&
					(result.target_deployment_id ?? null) !== (request.target_deployment_id ?? null))
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
		reconcileComputeSubscriptions: async (
			signal?: AbortSignal,
		): Promise<StoreComputeReconcileResponse> =>
			validateComputeReconcile(
				await transport.read(
					(init) => api.POST("/v2/store/compute-subscriptions/reconcile", init),
					signal,
				),
			),
	};
}

export type HostedStoreClient = ReturnType<typeof createHostedStoreClient>;
