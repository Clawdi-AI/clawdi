import type { StorePlatform } from "@clawdi/shared/api";
import { type StoreManagement, storeManagementUrl } from "@clawdi/shared/view";
import type { AccountScope } from "@/platform/auth/account-scope";
import type { RevenueCat } from "./revenuecat";
import { assertStoreAccount, type StoreIdentity } from "./store-identity";

export type StoreManagementResolution = Readonly<{
	provider: StoreManagement["provider"] | null;
	managementUrl: string | null;
	customerCenterAvailable: boolean;
	canManageInApp: boolean;
}>;

/** The build flag is the owner-approved RevenueCat Customer Center availability gate. */
export function resolveStoreManagement(
	management: StoreManagement | null | undefined,
	platform: StorePlatform,
	customerCenterEnabled: boolean,
): StoreManagementResolution {
	const managementUrl = storeManagementUrl(management, platform);
	return {
		provider: management?.provider ?? null,
		managementUrl,
		customerCenterAvailable: customerCenterEnabled,
		canManageInApp: customerCenterEnabled && management?.provider === platform,
	};
}

export function createStoreManagement(options: {
	scope: AccountScope;
	identity: Pick<StoreIdentity, "requireReady">;
	sdk: RevenueCat;
	platform: StorePlatform;
}) {
	const { scope, identity, sdk, platform } = options;
	return {
		resolve: (management: StoreManagement | null | undefined, customerCenterEnabled: boolean) =>
			resolveStoreManagement(management, platform, customerCenterEnabled),
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
		platform,
	};
}

export type StoreManagementController = ReturnType<typeof createStoreManagement>;
