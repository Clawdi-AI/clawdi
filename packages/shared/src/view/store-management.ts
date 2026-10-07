import type { DeployComponents } from "../api";
import type { StorePlatform } from "../api/store-client";

export type StoreManagement = DeployComponents["schemas"]["StoreManagement"];
export type StoreManagementProvider = StoreManagement["provider"];
export type StoreManagementState = StoreManagement["state"];

export const STORE_MANAGEMENT_URLS = {
	app_store: "https://apps.apple.com/account/subscriptions",
	play_store:
		"https://play.google.com/store/account/subscriptions?sku=ai.clawdi.app.compute&package=ai.clawdi.app",
	test_store: null,
} as const satisfies Record<StoreManagementProvider, string | null>;

export function storeManagementProvider(
	management: StoreManagement | null | undefined,
): StoreManagementProvider | null {
	return management?.provider ?? null;
}

export function storeManagementState(
	management: StoreManagement | null | undefined,
): StoreManagementState | null {
	return management?.state ?? null;
}

export function isStoreManagementOnPlatform(
	management: StoreManagement | null | undefined,
	platform: StorePlatform,
): boolean {
	return management?.provider === platform;
}

export function isStoreManagementOnOtherStore(
	management: StoreManagement | null | undefined,
	platform: StorePlatform,
): boolean {
	return (
		management?.provider !== undefined &&
		management.provider !== "test_store" &&
		management.provider !== platform
	);
}

/**
 * Returns the official management page only for the store on the current
 * platform. Test Store has no management page, and cross-platform rows have no
 * actionable URL.
 */
export function storeManagementUrl(
	management: StoreManagement | null | undefined,
	platform: StorePlatform,
): string | null {
	if (!management || !isStoreManagementOnPlatform(management, platform)) return null;
	return STORE_MANAGEMENT_URLS[management.provider];
}

export type StoreManagementPresentation = {
	provider: StoreManagementProvider | null;
	state: StoreManagementState | null;
	isOnThisPlatform: boolean;
	isOnOtherStore: boolean;
	managementUrl: string | null;
};

export function storeManagementPresentation(
	management: StoreManagement | null | undefined,
	platform: StorePlatform,
): StoreManagementPresentation {
	return {
		provider: storeManagementProvider(management),
		state: storeManagementState(management),
		isOnThisPlatform: isStoreManagementOnPlatform(management, platform),
		isOnOtherStore: isStoreManagementOnOtherStore(management, platform),
		managementUrl: storeManagementUrl(management, platform),
	};
}
