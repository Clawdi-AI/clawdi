import { isUuid, type StorePlatform } from "@clawdi/shared/api";
import Purchases, {
	type CustomerInfo,
	type MakePurchaseResult,
	type PurchasesOffering,
	type PurchasesStoreProduct,
	type PurchasesStoreTransaction,
	type StoreProductChangeInfo,
} from "react-native-purchases";
import type { MobileRuntimeConfig } from "@/lib/config/runtime-config";
import { StorePurchaseError } from "./store-error";

export type StoreTransactionHint = Pick<PurchasesStoreTransaction, "transactionIdentifier">;

export function revenueCatKey(config: MobileRuntimeConfig, platform: StorePlatform): string | null {
	return (
		(platform === "app_store" ? config.revenueCatAppleKey : config.revenueCatGoogleKey)?.trim() ||
		null
	);
}

/** RevenueCat offering presented by the credits Paywall (owner-configured). */
const CREDITS_OFFERING = "credits";

/** The Paywall picks the package; hosted confirm binds the product from the transaction. */
export async function loadCreditsOffering(): Promise<PurchasesOffering> {
	let offering: PurchasesOffering | undefined;
	try {
		offering = (await Purchases.getOfferings()).all[CREDITS_OFFERING];
	} catch {
		throw new StorePurchaseError("store_offering_unavailable");
	}
	if (!offering?.availablePackages.length)
		throw new StorePurchaseError("store_offering_unavailable");
	return offering;
}

/** One instance per process. Identity changes wait for the active native paywall. */
export function createRevenueCat(identityTimeoutMs = 300_000) {
	let configuredKey: string | null = null;
	let pending: Promise<void> = Promise.resolve();
	function serialize<T>(work: () => Promise<T>): Promise<T> {
		const result = pending.then(work);
		pending = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
	async function assertIdentity(appUserId: string, assertCurrent: () => void) {
		assertCurrent();
		if (!configuredKey) throw new StorePurchaseError("store_configuration_missing");
		const actual = await Purchases.getAppUserID();
		assertCurrent();
		if (actual !== appUserId) throw new StorePurchaseError("identity_mismatch");
	}
	function withIdentity<T>(
		appUserId: string,
		assertCurrent: () => void,
		work: (signal: AbortSignal) => Promise<T>,
		signal?: AbortSignal,
	): Promise<T> {
		// Caller timeout and SDK serialization have separate lifetimes. Native work
		// must settle before another account can change the SDK identity.
		return new Promise<T>((resolve, reject) => {
			void serialize(async () => {
				const controller = new AbortController();
				const abort = () => controller.abort(signal?.reason);
				if (signal?.aborted) abort();
				else signal?.addEventListener("abort", abort, { once: true });
				const assertActive = () => {
					assertCurrent();
					if (controller.signal.aborted)
						throw controller.signal.reason ?? new StorePurchaseError("store_operation_timeout");
				};
				const timer = setTimeout(() => {
					const error = new StorePurchaseError("store_operation_timeout");
					controller.abort(error);
					reject(error);
				}, identityTimeoutMs);
				try {
					await assertIdentity(appUserId, assertActive);
					assertActive();
					const result = await work(controller.signal);
					await assertIdentity(appUserId, assertActive);
					resolve(result);
				} catch (error) {
					reject(error);
				} finally {
					clearTimeout(timer);
					signal?.removeEventListener("abort", abort);
				}
			}).catch(reject);
		});
	}
	return {
		logIn: (apiKey: string, appUserId: string, assertCurrent: () => void) =>
			serialize(async () => {
				assertCurrent();
				if (!isUuid(appUserId)) throw new StorePurchaseError("store_identity_unavailable");
				if (configuredKey && configuredKey !== apiKey)
					throw new StorePurchaseError("store_configuration_invalid");
				if (!configuredKey) {
					Purchases.configure({ apiKey, appUserID: appUserId });
					configuredKey = apiKey;
				}
				await Purchases.logIn(appUserId);
				await assertIdentity(appUserId, assertCurrent);
			}),
		withIdentity,
		getProducts: (
			appUserId: string,
			assertCurrent: () => void,
			productIdentifiers: readonly string[],
			signal: AbortSignal,
		) =>
			withIdentity(
				appUserId,
				assertCurrent,
				() =>
					Purchases.getProducts([...productIdentifiers], Purchases.PRODUCT_CATEGORY.SUBSCRIPTION),
				signal,
			),
		getOfferings: (appUserId: string, assertCurrent: () => void, signal: AbortSignal) =>
			withIdentity(appUserId, assertCurrent, () => Purchases.getOfferings(), signal),
		purchaseStoreProduct: (
			appUserId: string,
			assertCurrent: () => void,
			product: PurchasesStoreProduct,
			changeInfo: StoreProductChangeInfo | null,
			signal: AbortSignal,
		): Promise<MakePurchaseResult> =>
			withIdentity(
				appUserId,
				assertCurrent,
				() => Purchases.purchaseStoreProduct(product, changeInfo),
				signal,
			),
		restorePurchases: (
			appUserId: string,
			assertCurrent: () => void,
			signal: AbortSignal,
		): Promise<CustomerInfo> =>
			withIdentity(appUserId, assertCurrent, () => Purchases.restorePurchases(), signal),
		showManageSubscriptions: (
			appUserId: string,
			assertCurrent: () => void,
			signal: AbortSignal,
		): Promise<void> =>
			withIdentity(appUserId, assertCurrent, () => Purchases.showManageSubscriptions(), signal),
		syncPurchases: (appUserId: string, assertCurrent: () => void, signal: AbortSignal) =>
			withIdentity(appUserId, assertCurrent, () => Purchases.syncPurchasesForResult(), signal),
	};
}

export type RevenueCat = ReturnType<typeof createRevenueCat>;
export const revenueCat = createRevenueCat();
