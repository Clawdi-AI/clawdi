import { type StorePurchaseAttemptRequest, storeIdempotencyHeaders } from "@clawdi/shared/api";
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
function isUuid(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value)
	);
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
		if (
			(request.platform !== "app_store" && request.platform !== "play_store") ||
			(request.purpose !== "standalone_topup" && request.purpose !== "deploy_continuation") ||
			typeof request.catalogue_revision !== "number" ||
			!Number.isSafeInteger(request.catalogue_revision) ||
			request.catalogue_revision < 1 ||
			(request.pending_deploy_request_id != null &&
				(typeof request.pending_deploy_request_id !== "string" ||
					request.pending_deploy_request_id.length < 1 ||
					request.pending_deploy_request_id.length > 191)) ||
			(request.purpose === "standalone_topup" && request.pending_deploy_request_id != null)
		)
			return null;
		const parsed: SavedPurchaseAttempt = {
			format: 1,
			key: value.key,
			appUserId: value.appUserId,
			request: {
				platform: request.platform,
				catalogue_revision: request.catalogue_revision,
				purpose: request.purpose,
				pending_deploy_request_id: request.pending_deploy_request_id ?? null,
			},
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
