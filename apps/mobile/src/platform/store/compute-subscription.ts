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
	"getProducts" | "getOfferings" | "purchaseStoreProduct" | "withIdentity"
>;
type StoreIdentityReader = Pick<StoreIdentity, "requireReady">;

export const COMPUTE_OFFERING_IDENTIFIER = "compute";
const COMPUTE_APPLE_PRODUCT_IDENTIFIERS = [
	"ai.clawdi.app.compute.basic.monthly",
	"ai.clawdi.app.compute.basic.annual",
	"ai.clawdi.app.compute.performance.monthly",
	"ai.clawdi.app.compute.performance.annual",
] as const;
export const COMPUTE_PLAY_PRODUCT_IDENTIFIERS = [
	"ai.clawdi.app.compute:basic-monthly",
	"ai.clawdi.app.compute:basic-annual",
	"ai.clawdi.app.compute:performance-monthly",
	"ai.clawdi.app.compute:performance-annual",
] as const;
const COMPUTE_PRODUCT_IDENTIFIERS_BY_PLATFORM = {
	app_store: COMPUTE_APPLE_PRODUCT_IDENTIFIERS,
	play_store: COMPUTE_PLAY_PRODUCT_IDENTIFIERS,
} as const;

export type ComputeProductIdentifier =
	| (typeof COMPUTE_APPLE_PRODUCT_IDENTIFIERS)[number]
	| (typeof COMPUTE_PLAY_PRODUCT_IDENTIFIERS)[number];
type ComputeStorePlatform = keyof typeof COMPUTE_PRODUCT_IDENTIFIERS_BY_PLATFORM;

export type ComputeProduct = Readonly<{
	productIdentifier: ComputeProductIdentifier;
	priceString: string;
}>;

export type ComputeProductSelection =
	| Readonly<{ kind: "product"; productIdentifier: ComputeProductIdentifier }>
	| Readonly<{
			/** The official Paywall purchases the package it selected once the attempt exists. */
			kind: "paywall";
			package: PurchasesPackage;
			purchase: (signal: AbortSignal) => Promise<StoreTransactionHint | null>;
	  }>;

type ComputeProductPlan = Readonly<{
	planSlug: "compute_basic" | "compute_performance";
	billingTermMonths: 1 | 12;
}>;

/** Both catalogues list Basic monthly, Basic annual, Performance monthly, Performance annual. */
const COMPUTE_PRODUCT_PLANS: readonly ComputeProductPlan[] = [
	{ planSlug: "compute_basic", billingTermMonths: 1 },
	{ planSlug: "compute_basic", billingTermMonths: 12 },
	{ planSlug: "compute_performance", billingTermMonths: 1 },
	{ planSlug: "compute_performance", billingTermMonths: 12 },
];

/** Plan and term of an App Store or Google Play compute product; null for anything else. */
export function computeProductPlan(productIdentifier: string): ComputeProductPlan | null {
	for (const identifiers of Object.values(COMPUTE_PRODUCT_IDENTIFIERS_BY_PLATFORM)) {
		const index = identifiers.findIndex((identifier) => identifier === productIdentifier);
		if (index !== -1) return COMPUTE_PRODUCT_PLANS[index] ?? null;
	}
	return null;
}

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

/** RevenueCat Android expects the Play subscription ID without its base-plan suffix. */
function androidSubscriptionIdentifier(productIdentifier: string): string {
	const trimmed = productIdentifier.trim();
	const separator = trimmed.indexOf(":");
	const subscriptionIdentifier = separator === -1 ? trimmed : trimmed.slice(0, separator);
	if (!subscriptionIdentifier) throw new StorePurchaseError("invalid_store_result");
	return subscriptionIdentifier;
}

/** Maps the server's transition decision to RevenueCat's documented Android argument. */
export function googleProductChangeInfo(
	attempt: Pick<StorePurchaseAttempt, "replacement_mode">,
	oldProductIdentifier: string,
): StoreProductChangeInfo {
	if (!oldProductIdentifier.trim() || !attempt.replacement_mode)
		throw new StorePurchaseError("invalid_store_result");
	return {
		oldProductIdentifier: androidSubscriptionIdentifier(oldProductIdentifier),
		replacementMode: replacementMode(attempt.replacement_mode),
	};
}

function productIdentifiersForPlatform(
	platform: ComputeStorePlatform,
): readonly ComputeProductIdentifier[] {
	return COMPUTE_PRODUCT_IDENTIFIERS_BY_PLATFORM[platform];
}

function validateProducts(
	products: readonly PurchasesStoreProduct[],
	productIdentifiers: readonly ComputeProductIdentifier[],
): ComputeProduct[] {
	const byIdentifier = new Map(products.map((product) => [product.identifier, product]));
	return productIdentifiers.map((productIdentifier) => {
		const product = byIdentifier.get(productIdentifier);
		if (!product?.priceString.trim()) throw new StorePurchaseError("store_offering_unavailable");
		return { productIdentifier, priceString: product.priceString };
	});
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
	platform: ComputeStorePlatform;
	signal: AbortSignal;
}): Promise<readonly ComputeProduct[]> {
	const { scope, identity, sdk, platform, signal } = options;
	const ready = identity.requireReady(signal);
	const productIdentifiers = productIdentifiersForPlatform(platform);
	try {
		const products = await sdk.getProducts(
			ready.appUserId,
			() => assertStoreAccount(scope, signal),
			productIdentifiers,
			signal,
		);
		assertStoreAccount(scope, signal);
		return validateProducts(products, productIdentifiers);
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
		// Plan changes buy a specific product with the server's replacement mode.
		if (selection.kind === "paywall" && attempt.target_contract_id)
			throw new StorePurchaseError("invalid_purchase_request");
		if (selectedIdentifier !== expectedIdentifier)
			throw new StorePurchaseError("store_attempt_conflict");
		if (platform === "play_store" && attempt.target_contract_id && !oldProductIdentifier)
			throw new StorePurchaseError("invalid_store_result");
		const changeInfo =
			platform === "play_store" && oldProductIdentifier
				? googleProductChangeInfo(attempt, oldProductIdentifier)
				: null;
		try {
			if (selection.kind === "paywall") {
				const transaction = await sdk.withIdentity(
					ready.appUserId,
					() => assertStoreAccount(scope, signal),
					selection.purchase,
					signal,
				);
				assertStoreAccount(scope, signal);
				return transaction ? transactionHint(transaction) : null;
			}
			const products = await sdk.getProducts(
				ready.appUserId,
				() => assertStoreAccount(scope, signal),
				[selectedIdentifier],
				signal,
			);
			const product = products.find((candidate) => candidate.identifier === selectedIdentifier);
			if (!product) throw new StorePurchaseError("store_offering_unavailable");
			const result = await sdk.purchaseStoreProduct(
				ready.appUserId,
				() => assertStoreAccount(scope, signal),
				product,
				changeInfo,
				signal,
			);
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
