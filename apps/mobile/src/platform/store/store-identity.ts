import type { HostedStoreClient, StoreBootstrap, StorePlatform } from "@clawdi/shared/api";
import type { MobileRuntimeConfig } from "@/lib/config/runtime-config";
import { type AccountScope, AccountScopeChangedError } from "@/platform/auth/account-scope";
import { type RevenueCat, revenueCatKey } from "./revenuecat";
import { StorePurchaseError } from "./store-error";

export type StoreAvailability =
	| { available: true; bootstrap: StoreBootstrap }
	| { available: false; reason: string };

export function assertStoreAccount(scope: AccountScope, signal: AbortSignal) {
	if (!scope.isReady || !scope.isCurrent() || scope.signal.aborted)
		throw new AccountScopeChangedError();
	if (signal.aborted) throw signal.reason ?? new Error("Store operation cancelled");
}

export function createStoreIdentity(options: {
	scope: AccountScope;
	client: HostedStoreClient | null;
	sdk: RevenueCat;
	config: MobileRuntimeConfig;
	platform: StorePlatform;
}) {
	const { scope, client, sdk, config, platform } = options;
	let ready: { appUserId: string; catalogueRevision: number; creditsEnabled: boolean } | null =
		null;
	return {
		initialize: async (signal: AbortSignal): Promise<StoreAvailability> => {
			ready = null;
			assertStoreAccount(scope, signal);
			const key = revenueCatKey(config, platform);
			if (!key || !client) return { available: false, reason: "store_configuration_missing" };
			const bootstrap = await client.bootstrap(platform, signal);
			assertStoreAccount(scope, signal);
			// Credits and compute subscriptions are independent hosted switches.
			if (!bootstrap.purchases_enabled && !bootstrap.compute_subscriptions_enabled)
				return { available: false, reason: bootstrap.reason ?? "store_purchases_disabled" };
			if (!bootstrap.app_user_id || !bootstrap.catalogue_revision)
				return { available: false, reason: "store_identity_unavailable" };
			await sdk.logIn(key, bootstrap.app_user_id, () => assertStoreAccount(scope, signal));
			assertStoreAccount(scope, signal);
			ready = {
				appUserId: bootstrap.app_user_id,
				catalogueRevision: bootstrap.catalogue_revision,
				creditsEnabled: bootstrap.purchases_enabled,
			};
			return { available: true, bootstrap };
		},
		requireReady: (signal: AbortSignal) => {
			assertStoreAccount(scope, signal);
			if (!ready) throw new StorePurchaseError("store_purchases_disabled");
			return ready;
		},
	};
}

export type StoreIdentity = ReturnType<typeof createStoreIdentity>;
