import type { StorePurchaseAttempt } from "@clawdi/shared/api";
import type {
	PurchasesOffering,
	PurchasesPackage,
	PurchasesStoreProduct,
	StoreProductChangeInfo,
} from "react-native-purchases";
import Purchases from "react-native-purchases";
import { type AccountScope, AccountScopeChangedError } from "@/platform/auth/account-scope";
import type { RevenueCat, StoreTransactionHint } from "./revenuecat";
import { StorePurchaseError } from "./store-error";
import { assertStoreAccount, type StoreIdentity } from "./store-identity";

type ComputeStoreSdk = Pick<
	RevenueCat,
	"getProducts" | "getOfferings" | "purchaseStoreProduct" | "purchasePackage"
>;
type StoreIdentityReader = Pick<StoreIdentity, "requireReady">;

export const COMPUTE_OFFERING_IDENTIFIER = "compute";
export const COMPUTE_PRODUCT_IDENTIFIERS = [
	"ai.clawdi.app.compute.basic.monthly",
	"ai.clawdi.app.compute.basic.annual",
	"ai.clawdi.app.compute.performance.monthly",
	"ai.clawdi.app.compute.performance.annual",
] as const;

export type ComputeProduct = Readonly<{
	productIdentifier: (typeof COMPUTE_PRODUCT_IDENTIFIERS)[number];
	priceString: string;
}>;

export type ComputeProductSelection =
	| Readonly<{ kind: "product"; productIdentifier: string }>
	| Readonly<{ kind: "package"; package: PurchasesPackage }>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

function isCancelledPurchase(error: unknown): boolean {
	return isRecord(error) && error.code === Purchases.PURCHASES_ERROR_CODE.PURCHASE_CANCELLED_ERROR;
}

function isPendingPurchase(error: unknown): boolean {
	return isRecord(error) && error.code === Purchases.PURCHASES_ERROR_CODE.PAYMENT_PENDING_ERROR;
}

function transactionHint(transaction: StoreTransactionHint): StoreTransactionHint {
	if (
		typeof transaction.transactionIdentifier !== "string" ||
		transaction.transactionIdentifier.trim().length === 0 ||
		transaction.transactionIdentifier.length > 255
	)
		throw new StorePurchaseError("invalid_store_result");
	return transaction;
}

function replacementMode(mode: NonNullable<StorePurchaseAttempt["replacement_mode"]>) {
	switch (mode) {
		case "CHARGE_PRORATED_PRICE":
			return Purchases.STORE_REPLACEMENT_MODE.CHARGE_PRORATED_PRICE;
		case "CHARGE_FULL_PRICE":
			return Purchases.STORE_REPLACEMENT_MODE.CHARGE_FULL_PRICE;
		case "DEFERRED":
			return Purchases.STORE_REPLACEMENT_MODE.DEFERRED;
	}
}

/** Maps the server's transition decision to RevenueCat's documented Android argument. */
export function googleProductChangeInfo(
	attempt: Pick<StorePurchaseAttempt, "replacement_mode">,
	oldProductIdentifier: string,
): StoreProductChangeInfo {
	if (!oldProductIdentifier.trim() || !attempt.replacement_mode)
		throw new StorePurchaseError("invalid_store_result");
	return {
		oldProductIdentifier,
		replacementMode: replacementMode(attempt.replacement_mode),
	};
}

function validateProducts(products: readonly PurchasesStoreProduct[]): ComputeProduct[] {
	const byIdentifier = new Map(products.map((product) => [product.identifier, product]));
	return COMPUTE_PRODUCT_IDENTIFIERS.map((productIdentifier) => {
		const product = byIdentifier.get(productIdentifier);
		if (!product?.priceString.trim()) throw new StorePurchaseError("store_offering_unavailable");
		return { productIdentifier, priceString: product.priceString };
	});
}

/** Fetches only the store-local display values. Prices never come from app code. */
export async function loadComputeProducts(): Promise<readonly ComputeProduct[]> {
	try {
		return validateProducts(
			await Purchases.getProducts(
				[...COMPUTE_PRODUCT_IDENTIFIERS],
				Purchases.PRODUCT_CATEGORY.SUBSCRIPTION,
			),
		);
	} catch (error) {
		if (error instanceof StorePurchaseError) throw error;
		throw new StorePurchaseError("store_offering_unavailable");
	}
}

export async function loadComputeOffering(): Promise<PurchasesOffering> {
	try {
		const offering = (await Purchases.getOfferings()).all[COMPUTE_OFFERING_IDENTIFIER];
		if (!offering?.availablePackages.length)
			throw new StorePurchaseError("store_offering_unavailable");
		return offering;
	} catch (error) {
		if (error instanceof StorePurchaseError) throw error;
		throw new StorePurchaseError("store_offering_unavailable");
	}
}

export async function loadComputeOfferingForIdentity(options: {
	scope: AccountScope;
	identity: StoreIdentityReader;
	sdk: ComputeStoreSdk;
	signal: AbortSignal;
}): Promise<PurchasesOffering> {
	const { scope, identity, sdk, signal } = options;
	const ready = identity.requireReady(signal);
	try {
		const offerings = await sdk.getOfferings(
			ready.appUserId,
			() => assertStoreAccount(scope, signal),
			signal,
		);
		const offering = offerings.all[COMPUTE_OFFERING_IDENTIFIER];
		if (!offering?.availablePackages.length)
			throw new StorePurchaseError("store_offering_unavailable");
		return offering;
	} catch (error) {
		if (error instanceof StorePurchaseError) throw error;
		if (error instanceof AccountScopeChangedError) throw error;
		throw new StorePurchaseError("store_offering_unavailable");
	}
}

export async function loadComputeProductsForIdentity(options: {
	scope: AccountScope;
	identity: StoreIdentityReader;
	sdk: ComputeStoreSdk;
	signal: AbortSignal;
}): Promise<readonly ComputeProduct[]> {
	const { scope, identity, sdk, signal } = options;
	const ready = identity.requireReady(signal);
	try {
		const products = await sdk.getProducts(
			ready.appUserId,
			() => assertStoreAccount(scope, signal),
			COMPUTE_PRODUCT_IDENTIFIERS,
			signal,
		);
		assertStoreAccount(scope, signal);
		return validateProducts(products);
	} catch (error) {
		if (error instanceof StorePurchaseError) throw error;
		if (error instanceof AccountScopeChangedError) throw error;
		throw new StorePurchaseError("store_offering_unavailable");
	}
}

export function createComputeSubscriptionPurchase(options: {
	scope: AccountScope;
	identity: StoreIdentityReader;
	sdk: ComputeStoreSdk;
	platform: "app_store" | "play_store";
}) {
	const { scope, identity, sdk, platform } = options;
	return async function purchase(
		attempt: StorePurchaseAttempt,
		selection: ComputeProductSelection,
		oldProductIdentifier: string | null,
		signal: AbortSignal,
	): Promise<StoreTransactionHint | null> {
		const ready = identity.requireReady(signal);
		assertStoreAccount(scope, signal);
		const expectedIdentifier =
			attempt.requested_store_product_id ?? attempt.store_product_id ?? null;
		if (!expectedIdentifier) throw new StorePurchaseError("invalid_store_result");
		const selectedIdentifier =
			selection.kind === "product"
				? selection.productIdentifier
				: selection.package.product.identifier;
		if (selectedIdentifier !== expectedIdentifier)
			throw new StorePurchaseError("store_attempt_conflict");
		if (platform === "play_store" && attempt.target_contract_id && !oldProductIdentifier)
			throw new StorePurchaseError("invalid_store_result");
		const changeInfo =
			platform === "play_store" && oldProductIdentifier
				? googleProductChangeInfo(attempt, oldProductIdentifier)
				: null;
		try {
			let product: PurchasesStoreProduct | null = null;
			if (selection.kind === "product") {
				const products = await sdk.getProducts(
					ready.appUserId,
					() => assertStoreAccount(scope, signal),
					[selectedIdentifier],
					signal,
				);
				product = products.find((candidate) => candidate.identifier === selectedIdentifier) ?? null;
				if (!product) throw new StorePurchaseError("store_offering_unavailable");
			}
			const result =
				selection.kind === "package"
					? await sdk.purchasePackage(
							ready.appUserId,
							() => assertStoreAccount(scope, signal),
							selection.package,
							changeInfo,
							signal,
						)
					: product
						? await sdk.purchaseStoreProduct(
								ready.appUserId,
								() => assertStoreAccount(scope, signal),
								product,
								changeInfo,
								signal,
							)
						: (() => {
								throw new StorePurchaseError("store_offering_unavailable");
							})();
			assertStoreAccount(scope, signal);
			return transactionHint(result.transaction);
		} catch (error) {
			assertStoreAccount(scope, signal);
			if (isCancelledPurchase(error)) return null;
			if (isPendingPurchase(error)) throw new StorePurchaseError("payment_pending");
			if (error instanceof StorePurchaseError) throw error;
			throw new StorePurchaseError("purchase_unconfirmed");
		}
	};
}
