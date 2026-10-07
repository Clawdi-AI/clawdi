import type { StorePlatform } from "@clawdi/shared/api";
import Purchases, { type PurchasesStoreTransaction } from "react-native-purchases";
import type { MobileRuntimeConfig } from "@/lib/config/runtime-config";
import { StorePurchaseError } from "./store-error";

export type StoreTransactionHint = Pick<PurchasesStoreTransaction, "transactionIdentifier">;

export function revenueCatKey(config: MobileRuntimeConfig, platform: StorePlatform): string | null {
	return (
		(platform === "app_store" ? config.revenueCatAppleKey : config.revenueCatGoogleKey)?.trim() ||
		null
	);
}

/** One instance per process. Identity changes wait for the active native paywall. */
export function createRevenueCat() {
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
	return {
		logIn: (apiKey: string, appUserId: string, assertCurrent: () => void) =>
			serialize(async () => {
				assertCurrent();
				if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(appUserId))
					throw new StorePurchaseError("store_identity_unavailable");
				if (configuredKey && configuredKey !== apiKey)
					throw new StorePurchaseError("store_configuration_invalid");
				if (!configuredKey) {
					Purchases.configure({ apiKey, appUserID: appUserId });
					configuredKey = apiKey;
				}
				await Purchases.logIn(appUserId);
				await assertIdentity(appUserId, assertCurrent);
			}),
		logOut: () =>
			serialize(async () => {
				if (configuredKey && !(await Purchases.isAnonymous())) await Purchases.logOut();
			}),
		withIdentity: <T>(appUserId: string, assertCurrent: () => void, work: () => Promise<T>) =>
			serialize(async () => {
				await assertIdentity(appUserId, assertCurrent);
				const result = await work();
				await assertIdentity(appUserId, assertCurrent);
				return result;
			}),
	};
}

export type RevenueCat = ReturnType<typeof createRevenueCat>;
export const revenueCat = createRevenueCat();
