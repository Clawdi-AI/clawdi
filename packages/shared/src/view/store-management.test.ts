import { describe, expect, test } from "bun:test";
import { formatShortDate } from "./format";
import {
	isStoreManagementOnOtherStore,
	isStoreManagementOnPlatform,
	STORE_MANAGEMENT_URLS,
	type StoreManagement,
	storeAgentDeletionNotice,
	storeBillingNotice,
	storeManagementPresentation,
	storeManagementProvider,
	storeManagementState,
	storeManagementUrl,
	storeProviderLabel,
	storeSubscriptionCardView,
	storeSubscriptionStatus,
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

	test("renders each store state read-only without falling back to card billing", () => {
		const fallback = { label: "Past due", tone: "destructive" } as const;
		const renewsAt = formatShortDate(appStoreManagement.renews_or_ends_at);
		const cases = [
			["active", "Active", "Renews"],
			["grace", "Grace period", "Renews"],
			["lapsed", "Billing issue", null],
			["paused", "Paused", null],
			["canceled_pending_end", "Canceling", "Ends"],
			["expired", "Expired", "Ended"],
			["revoked", "Ended", "Ended"],
			["unexpected", "Unavailable", null],
		] as const;
		for (const [state, label, verb] of cases) {
			const view = storeSubscriptionCardView({
				planSlug: "compute_performance",
				billingTermMonths: 12,
				management: { ...appStoreManagement, state },
				fallbackStatus: fallback,
			});
			expect(view.status.label).toBe(label);
			expect(view.plan).toBe("Performance plan");
			expect(view.commercialFacts.map(({ value }) => value)).toEqual([
				"Annual",
				"App Store",
				verb ? `${verb} ${renewsAt}` : "Unavailable",
			]);
			expect(JSON.stringify(view)).not.toContain("Card");
		}
		expect(
			storeSubscriptionCardView({
				planSlug: "compute_basic",
				billingTermMonths: 1,
				management: { ...appStoreManagement, state: "active", auto_renews: false },
				fallbackStatus: fallback,
			}).commercialFacts[2]?.value,
		).toBe(`Ends ${renewsAt}`);
		expect(storeSubscriptionStatus(null, fallback)).toBe(fallback);
	});

	test("names the billing store in Web notices and never links Test Store", () => {
		const playStore = { ...appStoreManagement, provider: "play_store" as const };
		const testStore = {
			...appStoreManagement,
			provider: "test_store" as const,
			management_url: null,
		};
		expect(storeBillingNotice(appStoreManagement)).toBe(
			"Billed through the App Store. Manage it on your device.",
		);
		expect(storeBillingNotice(playStore)).toBe(
			"Billed through Google Play. Manage it on your device.",
		);
		expect(storeBillingNotice(testStore)).toBe("Billed through Test Store.");
		expect(storeBillingNotice(null)).toBe(
			"Billed through the App Store or Google Play. Manage it on your device.",
		);
		for (const state of ["expired", "revoked", "owner_terminated"]) {
			expect(storeBillingNotice({ ...appStoreManagement, state })).toBe(
				"Was billed through the App Store.",
			);
		}
		expect(storeBillingNotice({ ...testStore, state: "expired" })).toBe(
			"Was billed through Test Store.",
		);
		expect(storeProviderLabel(testStore)).toBe("Test Store");
		expect(storeAgentDeletionNotice(playStore)).toBe(
			"Deleting this agent doesn't cancel your Google Play subscription. Manage it on your device.",
		);
		expect(storeAgentDeletionNotice(testStore)).toBe(
			"Deleting this agent doesn't cancel your Test Store subscription.",
		);
	});
});
