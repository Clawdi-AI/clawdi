import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { StoreComputeReconcileResponse } from "@clawdi/shared/api";
import { createAccountScope } from "@/platform/auth/account-scope";

const getProducts = mock(async (identifiers: string[], _category: string) =>
	identifiers.map((identifier) => ({ identifier, priceString: `$${identifier.length}` })),
);
let sdkUserId = "11111111-1111-4111-8111-111111111111";
const configure = mock((options: { appUserID: string }) => {
	sdkUserId = options.appUserID;
});
const logIn = mock(async (appUserId: string) => {
	sdkUserId = appUserId;
});
const getAppUserID = mock(async () => sdkUserId);
const getOfferings = mock(async () => ({
	all: {
		compute: {
			identifier: "compute",
			availablePackages: [
				{
					identifier: "basic_monthly",
					product: { identifier: "ai.clawdi.app.compute:basic-monthly" },
				},
			],
		},
	},
}));
const purchaseStoreProduct = mock(
	async (_product: { identifier: string }, _changeInfo: unknown) => ({
		transaction: { transactionIdentifier: "txn-product" },
	}),
);
const purchasePackage = mock(
	async (_pkg: { identifier: string }, _upgradeInfo: unknown, _changeInfo: unknown) => ({
		transaction: { transactionIdentifier: "txn-package" },
	}),
);
mock.module("react-native-purchases", () => ({
	default: {
		PRODUCT_CATEGORY: { SUBSCRIPTION: "SUBSCRIPTION" },
		STORE_REPLACEMENT_MODE: {
			CHARGE_PRORATED_PRICE: "CHARGE_PRORATED_PRICE",
			CHARGE_FULL_PRICE: "CHARGE_FULL_PRICE",
			DEFERRED: "DEFERRED",
		},
		PURCHASES_ERROR_CODE: { PURCHASE_CANCELLED_ERROR: "1", PAYMENT_PENDING_ERROR: "20" },
		configure,
		logIn,
		getAppUserID,
		getProducts,
		getOfferings,
		purchaseStoreProduct,
		purchasePackage,
	},
}));

const {
	COMPUTE_OFFERING_IDENTIFIER,
	COMPUTE_PLAY_PRODUCT_IDENTIFIERS,
	COMPUTE_PRODUCT_IDENTIFIERS,
	createComputeSubscriptionPurchase,
	googleProductChangeInfo,
	loadComputeOffering,
	loadComputeProducts,
} = await import("./compute-subscription");
const { resolveStoreManagement } = await import("./store-management");
const { preserveRestoreState, restoreStorePurchases, restoredComputeSlot } = await import(
	"./store-restore"
);

beforeEach(() => {
	getProducts.mockClear();
	getOfferings.mockClear();
	purchaseStoreProduct.mockClear();
	purchasePackage.mockClear();
	sdkUserId = "11111111-1111-4111-8111-111111111111";
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

	test("selects the four hosted Play product identifiers on Android", async () => {
		const products = await loadComputeProducts("play_store");
		expect(products.map((product) => product.productIdentifier)).toEqual([
			...COMPUTE_PLAY_PRODUCT_IDENTIFIERS,
		]);
		expect(getProducts).toHaveBeenCalledWith([...COMPUTE_PLAY_PRODUCT_IDENTIFIERS], "SUBSCRIPTION");
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
			const info = googleProductChangeInfo(
				{ replacement_mode },
				"ai.clawdi.app.compute:basic-monthly",
			);
			expect(info.oldProductIdentifier).toBe("ai.clawdi.app.compute");
			expect(String(info.replacementMode)).toBe(replacement_mode);
		}
	});

	test("carries the server replacement mode into direct and package purchases", async () => {
		const scope = createAccountScope("user:session", "user", "session", 0, () => true);
		const identity = {
			requireReady: () => ({
				appUserId: "11111111-1111-4111-8111-111111111111",
				catalogueRevision: 1,
			}),
		};
		const sdk = (await import("./revenuecat")).createRevenueCat();
		await sdk.logIn("public-key", "11111111-1111-4111-8111-111111111111", () => {});
		const purchase = createComputeSubscriptionPurchase({
			scope,
			identity,
			sdk,
			platform: "play_store",
		});
		const attempt = {
			platform: "play_store" as const,
			purpose: "compute_subscription" as const,
			catalogue_revision: 1,
			pending_deploy_request_id: null,
			target_contract_id: "11111111-1111-4111-8111-111111111111",
			target_deployment_id: null,
			store_product_id: "ai.clawdi.app.compute:basic-monthly",
			requested_store_product_id: "ai.clawdi.app.compute:basic-monthly",
			replacement_mode: "DEFERRED" as const,
			attempt_id: "22222222-2222-4222-8222-222222222222",
			state: "prepared" as const,
			expires_at: "2099-01-01T00:00:00Z",
		};
		const signal = new AbortController().signal;
		const offering = await loadComputeOffering();
		const packageSelection = offering.availablePackages[0];
		if (!packageSelection) throw new Error("Missing compute package fixture");
		await purchase(
			attempt,
			{ kind: "package", package: packageSelection },
			"ai.clawdi.app.compute:basic-monthly",
			signal,
		);
		expect(purchasePackage.mock.calls[0]?.[2]).toEqual({
			oldProductIdentifier: "ai.clawdi.app.compute",
			replacementMode: "DEFERRED",
		});
		await purchase(
			attempt,
			{ kind: "product", productIdentifier: "ai.clawdi.app.compute:basic-monthly" },
			"ai.clawdi.app.compute:basic-monthly",
			signal,
		);
		expect(purchaseStoreProduct.mock.calls[0]?.[1]).toEqual({
			oldProductIdentifier: "ai.clawdi.app.compute",
			replacementMode: "DEFERRED",
		});
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

	test("keeps the provider slot when owned-by-other-account reconciliation omits it", () => {
		const previous = { available: true, contract_id: "contract" };
		const response: StoreComputeReconcileResponse = {
			code: "owned_by_other_account" as const,
			results: [
				{ subscription_id: null, contract_id: null, code: "owned_by_other_account" as const },
			],
		};
		expect(restoredComputeSlot(previous, response)).toEqual(previous);
		expect(restoredComputeSlot(previous, { ...response, compute_slot: null })).toBeNull();
		const startup = {
			computeSlot: previous,
			recovery: ["startup-recovery"],
			error: "startup-error",
		};
		expect(preserveRestoreState(startup, response)).toEqual(startup);
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
		expect(resolveStoreManagement(appStore, "app_store", false).managementUrl).toBe(
			"https://apps.apple.com/account/subscriptions",
		);
		expect(resolveStoreManagement(appStore, "play_store", false).managementUrl).toBeNull();
		expect(
			resolveStoreManagement({ ...appStore, provider: "test_store" }, "app_store", false)
				.managementUrl,
		).toBeNull();
		const playStore = { ...appStore, provider: "play_store" as const };
		expect(resolveStoreManagement(playStore, "play_store", false)).toMatchObject({
			managementUrl:
				"https://play.google.com/store/account/subscriptions?sku=ai.clawdi.app.compute&package=ai.clawdi.app",
			canManageInApp: false,
		});
		expect(resolveStoreManagement(playStore, "app_store", true)).toMatchObject({
			managementUrl: null,
			customerCenterAvailable: true,
			canManageInApp: false,
		});
		expect(resolveStoreManagement(playStore, "play_store", true)).toMatchObject({
			customerCenterAvailable: true,
			canManageInApp: true,
		});
	});
});
