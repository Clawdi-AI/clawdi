import type { StorePlatform } from "@clawdi/shared/api";
import type { StoreManagement } from "@clawdi/shared/view";
import type { AccountScope } from "@/platform/auth/account-scope";
import type { RevenueCat } from "./revenuecat";
import { assertStoreAccount, type StoreIdentity } from "./store-identity";

/** The build flag gates the official Customer Center on the billing platform. */
export function canManageInApp(
	management: StoreManagement | null | undefined,
	platform: StorePlatform,
	enabled: boolean,
): boolean {
	return enabled && management?.provider === platform;
}

export function createStoreManagement(options: {
	scope: AccountScope;
	identity: Pick<StoreIdentity, "requireReady">;
	sdk: RevenueCat;
}) {
	const { scope, identity, sdk } = options;
	return {
		/** Presents the RevenueCat Customer Center under the store identity. */
		openCustomerCenter: async (
			present: () => Promise<void>,
			fallback: () => Promise<void>,
			signal: AbortSignal,
		) => {
			const ready = identity.requireReady(signal);
			try {
				await sdk.withIdentity(
					ready.appUserId,
					() => assertStoreAccount(scope, signal),
					present,
					signal,
				);
			} catch {
				assertStoreAccount(scope, signal);
				await fallback();
			}
		},
		openAppleManagement: async (fallback: () => Promise<void>, signal: AbortSignal) => {
			const ready = identity.requireReady(signal);
			try {
				await sdk.showManageSubscriptions(
					ready.appUserId,
					() => assertStoreAccount(scope, signal),
					signal,
				);
			} catch {
				assertStoreAccount(scope, signal);
				await fallback();
			}
		},
	};
}

export type StoreManagementController = ReturnType<typeof createStoreManagement>;
