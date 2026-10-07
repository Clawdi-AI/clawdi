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
		return serialize(async () => {
			const controller = new AbortController();
			const abort = () => controller.abort(signal?.reason);
			if (signal?.aborted) abort();
			else signal?.addEventListener("abort", abort, { once: true });
			const assertActive = () => {
				assertCurrent();
				if (controller.signal.aborted)
					throw controller.signal.reason ?? new StorePurchaseError("store_operation_timeout");
			};
			let timer: ReturnType<typeof setTimeout> | undefined;
			const timeout = new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					const error = new StorePurchaseError("store_operation_timeout");
					controller.abort(error);
					reject(error);
				}, identityTimeoutMs);
			});
			const operation = async () => {
				await assertIdentity(appUserId, assertActive);
				assertActive();
				const result = await work(controller.signal);
				await assertIdentity(appUserId, assertActive);
				return result;
			};
			try {
				return await Promise.race([operation(), timeout]);
			} finally {
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
			}
		});
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
		withIdentity,
		syncPurchases: (appUserId: string, assertCurrent: () => void, signal: AbortSignal) =>
			withIdentity(appUserId, assertCurrent, () => Purchases.syncPurchases(), signal),
	};
}

export type RevenueCat = ReturnType<typeof createRevenueCat>;
export const revenueCat = createRevenueCat();
