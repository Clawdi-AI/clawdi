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

export type CustomerCenterAvailabilityCheck = () => boolean | Promise<boolean>;

/**
 * RevenueCat UI 10.11 exposes presentation, but no availability probe in its
 * typings. M2 supplies a RevenueCat Pro availability check when configured;
 * without one the official store link remains the safe fallback.
 */
export async function resolveStoreManagement(
	management: StoreManagement | null | undefined,
	platform: StorePlatform,
	checkCustomerCenter?: CustomerCenterAvailabilityCheck,
): Promise<StoreManagementResolution> {
	let customerCenterAvailable = false;
	if (checkCustomerCenter) {
		try {
			customerCenterAvailable = await checkCustomerCenter();
		} catch {
			customerCenterAvailable = false;
		}
	}
	const managementUrl = storeManagementUrl(management, platform);
	return {
		provider: management?.provider ?? null,
		managementUrl,
		customerCenterAvailable,
		canManageInApp: customerCenterAvailable && management?.provider === platform,
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
		resolve: (
			management: StoreManagement | null | undefined,
			checkCustomerCenter?: CustomerCenterAvailabilityCheck,
		) => resolveStoreManagement(management, platform, checkCustomerCenter),
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
