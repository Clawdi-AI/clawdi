import { beforeEach, describe, expect, mock, test } from "bun:test";
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
	},
}));

const {
	computeProductPlan,
	createComputeSubscriptionPurchase,
	googleProductChangeInfo,
	loadComputeOfferingForIdentity,
	loadComputeProductsForIdentity,
} = await import("./compute-subscription");
const { canManageInApp } = await import("./store-management");
const { restoreStorePurchases } = await import("./store-restore");

beforeEach(() => {
	getProducts.mockClear();
	getOfferings.mockClear();
	purchaseStoreProduct.mockClear();
	sdkUserId = "11111111-1111-4111-8111-111111111111";
});

async function catalogueFixture() {
	const scope = createAccountScope("user:session", "user", "session", 0, () => true);
	const identity = {
		requireReady: () => ({
			appUserId: "11111111-1111-4111-8111-111111111111",
			catalogueRevision: 1,
		}),
	};
	const sdk = (await import("./revenuecat")).createRevenueCat();
	await sdk.logIn("public-key", "11111111-1111-4111-8111-111111111111", () => {});
	return { scope, identity, sdk, signal: scope.signal };
}

describe("compute store catalogue", () => {
	test("validates all four localized products under the store identity", async () => {
		const fixture = await catalogueFixture();
		for (const platform of ["app_store", "play_store"] as const) {
			const products = await loadComputeProductsForIdentity({ ...fixture, platform });
			expect(products).toHaveLength(4);
			for (const product of products)
				expect(product.priceString).toBe(`$${product.productIdentifier.length}`);
			expect(getProducts).toHaveBeenLastCalledWith(
				products.map((product) => product.productIdentifier),
				"SUBSCRIPTION",
			);
		}
		getProducts.mockImplementationOnce(async () => []);
		await expect(
			loadComputeProductsForIdentity({ ...fixture, platform: "app_store" }),
		).rejects.toMatchObject({ code: "store_offering_unavailable" });
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

	test("carries the server replacement mode into direct product purchases", async () => {
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

describe("Paywall compute purchases", () => {
	test("maps both store catalogues to plan and term", () => {
		expect(computeProductPlan("ai.clawdi.app.compute.performance.annual")).toEqual({
			planSlug: "compute_performance",
			billingTermMonths: 12,
		});
		expect(computeProductPlan("ai.clawdi.app.compute:basic-monthly")).toEqual({
			planSlug: "compute_basic",
			billingTermMonths: 1,
		});
		expect(computeProductPlan("ai.clawdi.app.credits.10")).toBeNull();
	});

	test("lets the Paywall buy the attempt's package under the store identity", async () => {
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
		const offering = await loadComputeOfferingForIdentity({
			scope,
			identity,
			sdk,
			signal: scope.signal,
		});
		const selected = offering.availablePackages[0];
		if (!selected) throw new Error("Missing compute package fixture");
		const attempt = {
			platform: "play_store" as const,
			purpose: "compute_subscription" as const,
			catalogue_revision: 1,
			pending_deploy_request_id: "33333333-3333-4333-8333-333333333333",
			target_contract_id: null,
			target_deployment_id: null,
			store_product_id: "ai.clawdi.app.compute:basic-monthly",
			requested_store_product_id: "ai.clawdi.app.compute:basic-monthly",
			attempt_id: "22222222-2222-4222-8222-222222222222",
			state: "prepared" as const,
			expires_at: "2099-01-01T00:00:00Z",
		};
		const signal = new AbortController().signal;
		const paywall = mock(async () => ({ transactionIdentifier: "GPA.1" }));
		expect(
			await purchase(
				attempt,
				{ kind: "paywall", package: selected, purchase: paywall },
				null,
				signal,
			),
		).toEqual({ transactionIdentifier: "GPA.1" });
		expect(paywall).toHaveBeenCalledTimes(1);
		expect(purchaseStoreProduct).not.toHaveBeenCalled();

		const otherProduct = {
			...attempt,
			requested_store_product_id: "ai.clawdi.app.compute:basic-annual",
		};
		await expect(
			purchase(
				otherProduct,
				{ kind: "paywall", package: selected, purchase: paywall },
				null,
				signal,
			),
		).rejects.toMatchObject({ code: "store_attempt_conflict" });
		const planChange = { ...attempt, target_contract_id: "11111111-1111-4111-8111-111111111111" };
		await expect(
			purchase(planChange, { kind: "paywall", package: selected, purchase: paywall }, null, signal),
		).rejects.toMatchObject({ code: "invalid_purchase_request" });
		expect(paywall).toHaveBeenCalledTimes(1);
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

describe("store Customer Center availability", () => {
	test("requires the build flag and the billing platform", () => {
		const management = {
			contract_id: "11111111-1111-4111-8111-111111111111",
			provider: "app_store" as const,
			product_id: "compute",
			management_url: null,
			auto_renews: true,
			renews_or_ends_at: null,
			state: "active",
		};
		expect(canManageInApp(management, "app_store", true)).toBe(true);
		expect(canManageInApp(management, "app_store", false)).toBe(false);
		expect(canManageInApp(management, "play_store", true)).toBe(false);
		expect(canManageInApp({ ...management, provider: "test_store" }, "app_store", true)).toBe(
			false,
		);
	});
});
