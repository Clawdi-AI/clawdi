import {
	isUuid,
	normalizeStorePurchaseAttemptRequest,
	type StorePurchaseAttemptRequest,
	storeIdempotencyHeaders,
} from "@clawdi/shared/api";
import { type AttemptStore, createSerializedAttemptStore } from "@/platform/attempt-store";

export type SavedPurchaseAttempt = Readonly<{
	format: 1;
	key: string;
	appUserId: string;
	request: StorePurchaseAttemptRequest;
	attemptId: string | null;
	purchaseStarted: boolean;
	cancelled: boolean;
	transactionHint: string | null;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function parsePurchaseAttempt(raw: string): SavedPurchaseAttempt | null {
	try {
		const value: unknown = JSON.parse(raw);
		if (
			!isRecord(value) ||
			value.format !== 1 ||
			typeof value.key !== "string" ||
			!isUuid(value.appUserId) ||
			!isRecord(value.request) ||
			(value.attemptId !== null && !isUuid(value.attemptId)) ||
			typeof value.purchaseStarted !== "boolean" ||
			(value.cancelled !== undefined && typeof value.cancelled !== "boolean") ||
			(value.cancelled === true && (!value.attemptId || value.purchaseStarted)) ||
			(value.transactionHint !== null &&
				(typeof value.transactionHint !== "string" ||
					value.transactionHint.length < 1 ||
					value.transactionHint.length > 255)) ||
			(value.purchaseStarted && !value.attemptId) ||
			(value.transactionHint !== null && !value.purchaseStarted)
		)
			return null;
		storeIdempotencyHeaders(value.key);
		const request = value.request;
		const normalized = normalizeStorePurchaseAttemptRequest(request);
		if (!normalized) return null;
		const normalizedRequest: StorePurchaseAttemptRequest = {
			...normalized,
			pending_deploy_request_id: normalized.pending_deploy_request_id ?? null,
		};
		if (normalizedRequest.purpose === "compute_subscription") {
			normalizedRequest.target_contract_id ??= null;
			normalizedRequest.target_deployment_id ??= null;
		}
		const parsed: SavedPurchaseAttempt = {
			format: 1,
			key: value.key,
			appUserId: value.appUserId,
			request: normalizedRequest,
			attemptId: value.attemptId,
			purchaseStarted: value.purchaseStarted,
			cancelled: value.cancelled ?? false,
			transactionHint: value.transactionHint,
		};
		// No unknown fields or client-selected product may enter a recovered request.
		if (
			Object.keys(value).some((key) => !Object.hasOwn(parsed, key)) ||
			Object.keys(request).some((key) => !Object.hasOwn(parsed.request, key))
		)
			return null;
		return parsed;
	} catch {
		return null;
	}
}

export function createPurchaseAttemptStore(store: AttemptStore) {
	return createSerializedAttemptStore(store, {
		parse: parsePurchaseAttempt,
		ownerError: "Purchase owner changed",
		sameIntent: (previous, next) =>
			previous.key === next.key &&
			previous.appUserId === next.appUserId &&
			JSON.stringify(previous.request) === JSON.stringify(next.request) &&
			(previous.attemptId === null || previous.attemptId === next.attemptId),
	});
}

export type PurchaseAttemptStore = ReturnType<typeof createPurchaseAttemptStore>;
