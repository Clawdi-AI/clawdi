import { readStoreErrorCode, type StoreErrorCode } from "@clawdi/shared/api";
import { AccountScopeChangedError } from "@/platform/auth/account-scope";

export type PurchaseErrorCode =
	| StoreErrorCode
	| "account_changed"
	| "identity_mismatch"
	| "purchase_pending"
	| "payment_pending"
	| "purchase_unconfirmed"
	| "store_offering_unavailable"
	| "paywall_unavailable"
	| "invalid_store_result"
	| "invalid_purchase_request"
	| "store_operation_timeout"
	| "store_request_failed";

export class StorePurchaseError extends Error {
	constructor(public readonly code: PurchaseErrorCode) {
		super("The store purchase could not be completed");
		this.name = "StorePurchaseError";
	}
}

/** Only safe typed codes cross the platform boundary; SDK/server messages stay private. */
export function storePurchaseError(error: unknown): StorePurchaseError {
	if (error instanceof StorePurchaseError) return error;
	if (error instanceof AccountScopeChangedError) return new StorePurchaseError("account_changed");
	return new StorePurchaseError(readStoreErrorCode(error) ?? "store_request_failed");
}
