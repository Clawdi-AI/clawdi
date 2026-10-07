import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createAccountScope } from "@/platform/auth/account-scope";

const getProducts = mock(async (identifiers: string[], _category: string) =>
	identifiers.map((identifier) => ({ identifier, priceString: `$${identifier.length}` })),
);
const getOfferings = mock(async () => ({
	all: { compute: { identifier: "compute", availablePackages: [{ identifier: "basic_monthly" }] } },
}));
mock.module("react-native-purchases", () => ({
	default: {
		PRODUCT_CATEGORY: { SUBSCRIPTION: "SUBSCRIPTION" },
		STORE_REPLACEMENT_MODE: {
			CHARGE_PRORATED_PRICE: "CHARGE_PRORATED_PRICE",
			CHARGE_FULL_PRICE: "CHARGE_FULL_PRICE",
			DEFERRED: "DEFERRED",
		},
		PURCHASES_ERROR_CODE: { PURCHASE_CANCELLED_ERROR: "1", PAYMENT_PENDING_ERROR: "20" },
		getProducts,
		getOfferings,
	},
}));

const {
	COMPUTE_OFFERING_IDENTIFIER,
	COMPUTE_PRODUCT_IDENTIFIERS,
	googleProductChangeInfo,
	loadComputeOffering,
	loadComputeProducts,
} = await import("./compute-subscription");
const { resolveStoreManagement } = await import("./store-management");
const { restoreStorePurchases } = await import("./store-restore");

beforeEach(() => {
	getProducts.mockClear();
	getOfferings.mockClear();
});

describe("compute store catalogue", () => {
	test("fetches all four subscription products and exposes only localized prices", async () => {
		const products = await loadComputeProducts();
		expect(products).toEqual(
			COMPUTE_PRODUCT_IDENTIFIERS.map((productIdentifier) => ({
				productIdentifier,
				priceString: `$${productIdentifier.length}`,
			})),
		);
		expect(getProducts).toHaveBeenCalledWith([...COMPUTE_PRODUCT_IDENTIFIERS], "SUBSCRIPTION");
	});

	test("loads the RevenueCat compute offering for package purchases", async () => {
		expect((await loadComputeOffering()).identifier).toBe(COMPUTE_OFFERING_IDENTIFIER);
		expect(getOfferings).toHaveBeenCalledTimes(1);
	});

	test("uses the server replacement mode without deriving a client mode", () => {
		for (const replacement_mode of [
			"CHARGE_PRORATED_PRICE",
			"CHARGE_FULL_PRICE",
			"DEFERRED",
		] as const) {
			const info = googleProductChangeInfo({ replacement_mode }, "current-product");
			expect(info.oldProductIdentifier).toBe("current-product");
			expect(String(info.replacementMode)).toBe(replacement_mode);
		}
	});
});

describe("restore purchases", () => {
	test("restores first and returns the typed aggregate with mixed per-result codes", async () => {
		const scope = createAccountScope("user:session", "user", "session", 0, () => true);
		const calls: string[] = [];
		const response = {
			code: "reconciled" as const,
			compute_slot: { available: true },
			results: [
				{ subscription_id: "owned", contract_id: null, code: "reconciled" as const },
				{ subscription_id: null, contract_id: null, code: "owned_by_other_account" as const },
			],
		};
		const result = await restoreStorePurchases({
			scope,
			identity: { requireReady: () => ({ appUserId: "app-user", catalogueRevision: 1 }) },
			sdk: {
				restorePurchases: async () => {
					calls.push("restore");
				},
			},
			client: {
				reconcileComputeSubscriptions: async () => {
					calls.push("reconcile");
					return response;
				},
			},
		});
		expect(calls).toEqual(["restore", "reconcile"]);
		expect(result).toEqual(response);
	});
});

describe("store management resolver", () => {
	test("uses same-platform links and suppresses cross-platform/test-store links", async () => {
		const appStore = {
			provider: "app_store" as const,
			product_id: "compute",
			management_url: null,
			auto_renews: true,
			renews_or_ends_at: null,
			state: "active",
		};
		expect((await resolveStoreManagement(appStore, "app_store")).managementUrl).toBe(
			"https://apps.apple.com/account/subscriptions",
		);
		expect((await resolveStoreManagement(appStore, "play_store")).managementUrl).toBeNull();
		expect(
			(await resolveStoreManagement({ ...appStore, provider: "test_store" }, "app_store"))
				.managementUrl,
		).toBeNull();
	});
});
