import { describe, expect, test } from "bun:test";
import {
	isStoreManagementOnOtherStore,
	isStoreManagementOnPlatform,
	STORE_MANAGEMENT_URLS,
	type StoreManagement,
	storeManagementPresentation,
	storeManagementProvider,
	storeManagementState,
	storeManagementUrl,
} from "./store-management";

const appStoreManagement: StoreManagement = {
	provider: "app_store",
	product_id: "ai.clawdi.app.compute.basic.monthly",
	management_url: STORE_MANAGEMENT_URLS.app_store,
	auto_renews: true,
	renews_or_ends_at: "2026-10-08T12:00:00Z",
	state: "grace",
};

describe("store management presentation", () => {
	test("keeps provider and lifecycle state, including grace/lapse/paused values", () => {
		expect(storeManagementProvider(appStoreManagement)).toBe("app_store");
		expect(storeManagementState(appStoreManagement)).toBe("grace");
		for (const state of ["lapse", "paused"]) {
			expect(storeManagementState({ ...appStoreManagement, state })).toBe(state);
		}
	});

	test("distinguishes the current store from a cross-platform store", () => {
		expect(isStoreManagementOnPlatform(appStoreManagement, "app_store")).toBe(true);
		expect(isStoreManagementOnPlatform(appStoreManagement, "play_store")).toBe(false);
		expect(isStoreManagementOnOtherStore(appStoreManagement, "play_store")).toBe(true);
		expect(isStoreManagementOnOtherStore(appStoreManagement, "app_store")).toBe(false);
	});

	test("returns official management URLs only on the owning platform", () => {
		expect(storeManagementUrl(appStoreManagement, "app_store")).toBe(
			STORE_MANAGEMENT_URLS.app_store,
		);
		expect(storeManagementUrl(appStoreManagement, "play_store")).toBeNull();
		expect(
			storeManagementUrl(
				{ ...appStoreManagement, provider: "test_store", management_url: null },
				"app_store",
			),
		).toBeNull();
		expect(storeManagementPresentation(appStoreManagement, "app_store")).toEqual({
			provider: "app_store",
			state: "grace",
			isOnThisPlatform: true,
			isOnOtherStore: false,
			managementUrl: STORE_MANAGEMENT_URLS.app_store,
		});
	});
});
