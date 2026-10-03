import { expect, test } from "bun:test";
import {
	createRevenueCatPurchaseBoundary,
	type RevenueCatPurchaseClient,
	resolveRevenueCatPurchaseAvailability,
} from "./purchase-boundary";

const valid = {
	platform: "ios" as const,
	apiKey: "appl_public_example",
	productId: "compute_basic_monthly",
	hostedSyncAvailable: true,
	sdkAvailable: true,
};

test("purchase capability is explicit and refuses unsupported or incomplete setup", () => {
	expect(resolveRevenueCatPurchaseAvailability({ ...valid, platform: "web" })).toEqual({
		state: "unsupported",
		reason: "platform_not_supported",
		platform: "web",
	});
	expect(resolveRevenueCatPurchaseAvailability({ ...valid, apiKey: "sk_live_secret" })).toEqual({
		state: "disabled",
		reason: "missing_api_key",
	});
	expect(
		resolveRevenueCatPurchaseAvailability({
			...valid,
			platform: "android",
			apiKey: "appl_wrong_platform_key",
		}),
	).toEqual({ state: "disabled", reason: "missing_api_key" });
	expect(resolveRevenueCatPurchaseAvailability({ ...valid, apiKey: "bad\nkey" })).toEqual({
		state: "disabled",
		reason: "missing_api_key",
	});
	expect(resolveRevenueCatPurchaseAvailability({ ...valid, productId: "../subscription" })).toEqual(
		{ state: "disabled", reason: "missing_product_id" },
	);
	expect(resolveRevenueCatPurchaseAvailability({ ...valid, hostedSyncAvailable: false })).toEqual({
		state: "disabled",
		reason: "hosted_sync_unavailable",
	});
});

test("disabled boundaries never invoke an injected store client", async () => {
	let calls = 0;
	const client: RevenueCatPurchaseClient = {
		configure: () => {
			calls += 1;
		},
		purchaseProduct: async () => {
			calls += 1;
		},
		restorePurchases: async () => {
			calls += 1;
		},
	};
	const boundary = createRevenueCatPurchaseBoundary({
		...valid,
		hostedSyncAvailable: false,
		accountId: "user_123",
		client,
	});
	expect(await boundary.purchase()).toEqual({
		state: "disabled",
		reason: "hosted_sync_unavailable",
	});
	expect(await boundary.restore()).toEqual({
		state: "disabled",
		reason: "hosted_sync_unavailable",
	});
	expect(calls).toBe(0);
});

test("ready boundaries configure once per account and map provider errors", async () => {
	let configureCalls = 0;
	let purchaseCalls = 0;
	const client: RevenueCatPurchaseClient = {
		configure: ({ apiKey, appUserId }) => {
			expect(apiKey).toBe("appl_public_example");
			expect(appUserId).toBe("user_123");
			configureCalls += 1;
		},
		purchaseProduct: async (productId) => {
			expect(productId).toBe("compute_basic_monthly");
			purchaseCalls += 1;
		},
		restorePurchases: async () => {
			throw new Error("SDK diagnostic must not escape");
		},
	};
	const boundary = createRevenueCatPurchaseBoundary({ ...valid, accountId: "user_123", client });
	expect(await boundary.purchase()).toEqual({ state: "completed" });
	expect(await boundary.restore()).toEqual({ state: "failed", reason: "provider_error" });
	expect(configureCalls).toBe(1);
	expect(purchaseCalls).toBe(1);
});

test("ready actions require a signed-in account", async () => {
	const boundary = createRevenueCatPurchaseBoundary({ ...valid, accountId: null });
	expect(await boundary.purchase()).toEqual({ state: "disabled", reason: "account_required" });
});
