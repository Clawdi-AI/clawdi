import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
	ApiClientError,
	type HostedStoreClient,
	StoreErrorCode,
	type StorePurchaseAttempt,
	type StorePurchaseAttemptRequest,
} from "@clawdi/shared/api";
import type { MobileRuntimeConfig } from "@/lib/config/runtime-config";
import { createAccountScope } from "@/platform/auth/account-scope";
import { createPurchaseAttemptStore, parsePurchaseAttempt } from "./purchase-attempt-storage";
import { isStoreBuild } from "./store-policy";

const appUserId = "11111111-1111-4111-8111-111111111111";
const otherAppUserId = "22222222-2222-4222-8222-222222222222";
const attemptId = "33333333-3333-4333-8333-333333333333";
let sdkUserId = appUserId;
let anonymous = false;
const configure = mock((options: { appUserID: string }) => {
	sdkUserId = options.appUserID;
});
const logIn = mock(async (id: string) => {
	sdkUserId = id;
	anonymous = false;
	return {};
});
const logOut = mock(async () => {
	sdkUserId = "$RCAnonymousID:test";
	anonymous = true;
	return {};
});
const getAppUserID = mock(async () => sdkUserId);
mock.module("react-native-purchases", () => ({
	default: {
		configure,
		logIn,
		logOut,
		getAppUserID,
		isAnonymous: async () => anonymous,
	},
}));
const { createRevenueCat, revenueCatKey } = await import("./revenuecat");
const { createStoreIdentity } = await import("./store-identity");
const { createPurchaseFlow } = await import("./purchase-flow");

beforeEach(() => {
	sdkUserId = appUserId;
	anonymous = false;
	for (const fn of [configure, logIn, logOut, getAppUserID]) fn.mockClear();
});

function deferred<T>() {
	let resolve: (value: T) => void = () => {
		throw new Error("Not initialized");
	};
	const promise = new Promise<T>((yes) => {
		resolve = yes;
	});
	return { promise, resolve };
}

function fixture(configOverrides: Partial<MobileRuntimeConfig> = {}) {
	let current = true;
	const scope = createAccountScope("account:session", "account", "session", 0, () => current);
	const config: MobileRuntimeConfig = {
		cloudApiUrl: "https://cloud.example.test",
		clerkPublishableKey: "pk_test_fixture",
		computeApiUrl: "https://compute.example.test",
		revenueCatAppleKey: "public-sdk-key",
		...configOverrides,
	};
	const values = new Map<string, string>();
	const store = {
		getItemAsync: async (key: string) => values.get(key) ?? null,
		setItemAsync: async (key: string, value: string) => {
			values.set(key, value);
		},
		deleteItemAsync: async (key: string) => {
			values.delete(key);
		},
	};
	const request: StorePurchaseAttemptRequest = {
		platform: "app_store",
		catalogue_revision: 1,
		purpose: "standalone_topup",
		pending_deploy_request_id: null,
	};
	let attempt: StorePurchaseAttempt = {
		...request,
		attempt_id: attemptId,
		state: "prepared",
		expires_at: "2099-01-01T00:00:00Z",
	};
	const bootstrap = mock(async () => ({
		purchases_enabled: true,
		app_user_id: appUserId,
		catalogue_revision: 1,
		products: [],
		wallet: { balance_available: true, balance_usd: "0", open_debt: false },
	}));
	const createPurchaseAttempt = mock(async (body: StorePurchaseAttemptRequest, key: string) => {
		const saved = parsePurchaseAttempt(values.get("journal") ?? "");
		expect(saved?.key).toBe(key);
		expect(saved?.request).toEqual(body);
		return attempt;
	});
	const confirmPurchaseAttempt = mock(
		async (id: string, _body: { store_transaction_id?: string | null } = {}) => {
			expect(id).toBe(attemptId);
			return { state: "verification_pending" as const, correlation_id: "safe-correlation" };
		},
	);
	const getPurchaseAttempt = mock(async () => attempt);
	const listPurchaseAttempts = mock(async () => [] as StorePurchaseAttempt[]);
	const client: HostedStoreClient = {
		bootstrap,
		createPurchaseAttempt,
		confirmPurchaseAttempt,
		getPurchaseAttempt,
		listPurchaseAttempts,
	};
	let time = 0;
	const delays: number[] = [];
	const clock = {
		now: () => time,
		sleep: async (ms: number) => {
			delays.push(ms);
			time += ms;
		},
	};
	const sdk = createRevenueCat();
	const identity = createStoreIdentity({ scope, client, sdk, config, platform: "app_store" });
	const newKey = mock(() => "persisted-idempotency-key");
	const makeFlow = (processSdk = sdk, processIdentity = identity) =>
		createPurchaseFlow({
			scope,
			client,
			sdk: processSdk,
			identity: processIdentity,
			platform: "app_store",
			journal: createPurchaseAttemptStore(store),
			storageKey: "journal",
			newKey,
			clock,
		});
	return {
		scope,
		config,
		values,
		store,
		sdk,
		client,
		identity,
		bootstrap,
		createPurchaseAttempt,
		confirmPurchaseAttempt,
		getPurchaseAttempt,
		listPurchaseAttempts,
		newKey,
		makeFlow,
		delays,
		initialize: () => identity.initialize(scope.signal),
		setAttempt: (state: StorePurchaseAttempt["state"]) => {
			attempt = { ...attempt, state };
		},
		switchAccount: () => {
			current = false;
			scope.abort();
		},
	};
}
const intent = { purpose: "standalone_topup" } as const;
const transaction = { transactionIdentifier: "store-transaction-1" };

describe("store account identity", () => {
	test("configures once, logs in with bootstrap identity, and logs out on sign-out", async () => {
		const f = fixture();
		expect((await f.initialize()).available).toBe(true);
		await f.initialize();
		expect(configure).toHaveBeenCalledTimes(1);
		expect(logIn).toHaveBeenCalledWith(appUserId);
		f.switchAccount();
		await f.sdk.logOut();
		await f.sdk.logOut();
		expect(logOut).toHaveBeenCalledTimes(1);
	});
	test("disabled bootstrap with null identity never touches SDK or opens a paywall", async () => {
		const f = fixture();
		f.client.bootstrap = async () => ({
			purchases_enabled: false,
			app_user_id: null,
			reason: "store_purchases_disabled",
		});
		expect(await f.initialize()).toEqual({ available: false, reason: "store_purchases_disabled" });
		const paywall = mock(async () => transaction);
		await expect(f.makeFlow().purchase(intent, paywall)).rejects.toMatchObject({
			code: "store_purchases_disabled",
		});
		expect(configure).not.toHaveBeenCalled();
		expect(logIn).not.toHaveBeenCalled();
		expect(paywall).not.toHaveBeenCalled();
		expect(f.createPurchaseAttempt).not.toHaveBeenCalled();
	});
	test("unset platform keys keep store purchases unavailable", async () => {
		const f = fixture({ revenueCatAppleKey: undefined, revenueCatGoogleKey: "google-key" });
		expect(await f.initialize()).toEqual({
			available: false,
			reason: "store_configuration_missing",
		});
		expect(f.bootstrap).not.toHaveBeenCalled();
		expect(configure).not.toHaveBeenCalled();
		expect(revenueCatKey(f.config, "play_store")).toBe("google-key");
	});
	test("SDK identity mismatch blocks journal creation and native purchase", async () => {
		const f = fixture();
		await f.initialize();
		sdkUserId = otherAppUserId;
		const paywall = mock(async () => transaction);
		await expect(f.makeFlow().purchase(intent, paywall)).rejects.toMatchObject({
			code: "identity_mismatch",
		});
		expect(f.values.size).toBe(0);
		expect(f.createPurchaseAttempt).not.toHaveBeenCalled();
		expect(paywall).not.toHaveBeenCalled();
	});
	test("identity mismatch after paywall completion cannot confirm or clear the journal", async () => {
		const f = fixture();
		await f.initialize();
		await expect(
			f.makeFlow().purchase(intent, async () => {
				sdkUserId = otherAppUserId;
				return transaction;
			}),
		).rejects.toMatchObject({ code: "identity_mismatch" });
		expect(f.confirmPurchaseAttempt).not.toHaveBeenCalled();
		expect(f.values.size).toBe(1);
	});
	test("account switch during native purchase fences confirm and serializes the next login", async () => {
		const f = fixture();
		await f.initialize();
		const opened = deferred<void>();
		const purchase = deferred<typeof transaction>();
		const pending = f.makeFlow().purchase(intent, async () => {
			opened.resolve();
			return purchase.promise;
		});
		await opened.promise;
		f.switchAccount();
		const newScope = createAccountScope("other:session", "other", "session", 1, () => true);
		const next = createStoreIdentity({
			scope: newScope,
			client: {
				...f.client,
				bootstrap: async () => ({
					purchases_enabled: true,
					app_user_id: otherAppUserId,
					catalogue_revision: 1,
				}),
			},
			sdk: f.sdk,
			config: f.config,
			platform: "app_store",
		});
		const nextLogin = next.initialize(newScope.signal);
		await Promise.resolve();
		expect(logIn).toHaveBeenCalledTimes(1);
		purchase.resolve(transaction);
		await expect(pending).rejects.toMatchObject({ code: "account_changed" });
		expect((await nextLogin).available).toBe(true);
		expect(sdkUserId).toBe(otherAppUserId);
		expect(f.confirmPurchaseAttempt).not.toHaveBeenCalled();
		expect(parsePurchaseAttempt(f.values.get("journal") ?? "")?.purchaseStarted).toBe(true);
	});
});

describe("durable store attempts", () => {
	test("multiple pending server attempts share one foreground polling budget", async () => {
		const f = fixture();
		await f.initialize();
		const pending: StorePurchaseAttempt = {
			attempt_id: attemptId,
			state: "verification_pending",
			expires_at: "2099-01-01T00:00:00Z",
			platform: "app_store",
			purpose: "standalone_topup",
			catalogue_revision: 1,
		};
		f.listPurchaseAttempts.mockImplementationOnce(async () => [
			pending,
			{ ...pending, attempt_id: otherAppUserId },
		]);
		const results = await f.makeFlow().recover();
		expect(results.map((result) => result.status)).toEqual(["pending", "pending"]);
		expect(f.delays.reduce((total, delay) => total + delay, 0)).toBe(120_000);
		expect(f.confirmPurchaseAttempt).toHaveBeenCalledTimes(1);
	});
	test("recovery finds server pending attempts when no local journal remains", async () => {
		const f = fixture();
		await f.initialize();
		f.setAttempt("verification_pending");
		f.listPurchaseAttempts.mockImplementationOnce(async () => [await f.getPurchaseAttempt()]);
		f.getPurchaseAttempt.mockImplementationOnce(async () => ({
			attempt_id: attemptId,
			state: "verification_pending",
			platform: "app_store",
			purpose: "standalone_topup",
			catalogue_revision: 1,
			expires_at: "2099-01-01T00:00:00Z",
		}));
		f.setAttempt("funding_applied");
		expect((await f.makeFlow().recover())[0]?.status).toBe("funding_applied");
		expect(f.confirmPurchaseAttempt).toHaveBeenCalledTimes(1);
		expect(f.createPurchaseAttempt).not.toHaveBeenCalled();
		expect(f.newKey).not.toHaveBeenCalled();
	});
	test("corrupt durable input stops recovery without mutating the saved journal", async () => {
		const f = fixture();
		await f.initialize();
		f.values.set("journal", '{"format":1,"request":{"store_product_id":"unapproved"}}');
		const raw = f.values.get("journal");
		await expect(f.makeFlow().recover()).rejects.toMatchObject({ code: "store_request_failed" });
		expect(f.values.get("journal")).toBe(raw);
		expect(f.createPurchaseAttempt).not.toHaveBeenCalled();
		expect(f.confirmPurchaseAttempt).not.toHaveBeenCalled();
	});
	test("stale journal writers cannot clear a newer purchase marker", async () => {
		const f = fixture();
		await f.initialize();
		await f.makeFlow().purchase(intent, async () => null);
		const previous = parsePurchaseAttempt(f.values.get("journal") ?? "");
		if (!previous) throw new Error("Missing journal fixture");
		const journal = createPurchaseAttemptStore(f.store);
		const next = { ...previous, purchaseStarted: true };
		await journal.replaceAttempt("journal", previous, next, () => true);
		await expect(journal.clearAttempt("journal", previous, () => true)).rejects.toThrow(
			"Saved request changed",
		);
		expect(await journal.readSavedAttempt("journal")).toEqual(next);
	});
	test("lost create response retries with the persisted key and original revision", async () => {
		const f = fixture();
		await f.initialize();
		f.createPurchaseAttempt.mockImplementationOnce(async () => {
			throw new Error("Lost response");
		});
		const paywall = mock(async () => null);
		await expect(f.makeFlow().purchase(intent, paywall)).rejects.toMatchObject({
			code: "store_request_failed",
		});
		expect(paywall).not.toHaveBeenCalled();
		f.client.bootstrap = async () => ({
			purchases_enabled: true,
			app_user_id: appUserId,
			catalogue_revision: 2,
		});
		await f.initialize();
		expect((await f.makeFlow().purchase(intent, paywall)).status).toBe("cancelled");
		expect(f.newKey).toHaveBeenCalledTimes(1);
		expect(f.createPurchaseAttempt.mock.calls.map((call) => call.slice(0, 2))).toEqual([
			[
				{
					platform: "app_store",
					catalogue_revision: 1,
					purpose: "standalone_topup",
					pending_deploy_request_id: null,
				},
				"persisted-idempotency-key",
			],
			[
				{
					platform: "app_store",
					catalogue_revision: 1,
					purpose: "standalone_topup",
					pending_deploy_request_id: null,
				},
				"persisted-idempotency-key",
			],
		]);
	});
	test("write failure prevents create-attempt and purchase", async () => {
		const f = fixture();
		await f.initialize();
		f.store.setItemAsync = async () => {
			throw new Error("SecureStore failed");
		};
		const paywall = mock(async () => transaction);
		await expect(f.makeFlow().purchase(intent, paywall)).rejects.toMatchObject({
			code: "store_request_failed",
		});
		expect(f.createPurchaseAttempt).not.toHaveBeenCalled();
		expect(paywall).not.toHaveBeenCalled();
	});
	test("restart recovers the saved transaction hint without starting a second purchase", async () => {
		const f = fixture();
		await f.initialize();
		f.confirmPurchaseAttempt.mockImplementationOnce(async () => {
			throw new Error("App terminated after store charge");
		});
		await expect(f.makeFlow().purchase(intent, async () => transaction)).rejects.toMatchObject({
			code: "store_request_failed",
		});
		const saved = parsePurchaseAttempt(f.values.get("journal") ?? "");
		expect(saved?.transactionHint).toBe(transaction.transactionIdentifier);
		f.setAttempt("funding_applied");
		f.getPurchaseAttempt.mockImplementationOnce(async () => ({
			...saved?.request,
			platform: "app_store",
			purpose: "standalone_topup",
			catalogue_revision: 1,
			attempt_id: attemptId,
			state: "verification_pending",
			expires_at: "2099-01-01T00:00:00Z",
		}));
		const restartedSdk = createRevenueCat();
		const restartedIdentity = createStoreIdentity({
			scope: f.scope,
			client: f.client,
			sdk: restartedSdk,
			config: f.config,
			platform: "app_store",
		});
		await restartedIdentity.initialize(f.scope.signal);
		expect((await f.makeFlow(restartedSdk, restartedIdentity).recover())[0]?.status).toBe(
			"funding_applied",
		);
		expect(f.confirmPurchaseAttempt.mock.calls[1]?.[1]).toEqual({
			store_transaction_id: transaction.transactionIdentifier,
		});
		expect(f.createPurchaseAttempt).toHaveBeenCalledTimes(1);
		expect(f.newKey).toHaveBeenCalledTimes(1);
		expect(f.values.size).toBe(0);
	});
	test("interrupted native result recovers without a hint and never reopens the paywall", async () => {
		const f = fixture();
		await f.initialize();
		await expect(
			f.makeFlow().purchase(intent, async () => {
				throw new Error("Deferred native result");
			}),
		).rejects.toMatchObject({ code: "store_request_failed" });
		const secondPaywall = mock(async () => transaction);
		const result = await f.makeFlow().purchase(intent, secondPaywall);
		expect(result.status).toBe("pending");
		expect(secondPaywall).not.toHaveBeenCalled();
		expect(f.confirmPurchaseAttempt.mock.calls[0]?.[1]).toEqual({ store_transaction_id: null });
		expect(parsePurchaseAttempt(f.values.get("journal") ?? "")?.purchaseStarted).toBe(true);
	});
	test("pending settlement times out after bounded backoff and is retained for foreground recovery", async () => {
		const f = fixture();
		await f.initialize();
		f.setAttempt("prepared");
		const result = await f.makeFlow().purchase(intent, async () => transaction);
		expect(result.status).toBe("pending");
		expect(f.delays).toEqual([2000, 4000, 8000, 16000, 30000, 30000, 30000]);
		expect(f.values.size).toBe(1);
		f.setAttempt("funding_applied");
		expect((await f.makeFlow().recover())[0]?.status).toBe("funding_applied");
		expect(f.values.size).toBe(0);
	});
	for (const state of ["canceled", "expired", "rejected", "reconciliation_required"] as const) {
		test(`server ${state} stops polling`, async () => {
			const f = fixture();
			await f.initialize();
			f.setAttempt(state);
			const paywall = mock(async () => transaction);
			expect((await f.makeFlow().purchase(intent, paywall)).status).toBe("terminal");
			expect(paywall).not.toHaveBeenCalled();
			expect(f.delays).toEqual([]);
			expect(f.values.size).toBe(state === "reconciliation_required" ? 1 : 0);
		});
	}
	test("account switch while create is pending cannot open the native paywall", async () => {
		const f = fixture();
		await f.initialize();
		const sent = deferred<void>();
		const response = deferred<StorePurchaseAttempt>();
		f.createPurchaseAttempt.mockImplementationOnce(async () => {
			sent.resolve();
			return response.promise;
		});
		const paywall = mock(async () => transaction);
		const pending = f.makeFlow().purchase(intent, paywall);
		await sent.promise;
		f.switchAccount();
		response.resolve({
			attempt_id: attemptId,
			state: "prepared",
			expires_at: "2099-01-01T00:00:00Z",
			platform: "app_store",
			purpose: "standalone_topup",
			catalogue_revision: 1,
		});
		await expect(pending).rejects.toMatchObject({ code: "account_changed" });
		expect(paywall).not.toHaveBeenCalled();
		expect(parsePurchaseAttempt(f.values.get("journal") ?? "")?.attemptId).toBeNull();
	});
	test("foreground cancellation stops polling without discarding purchase evidence", async () => {
		const f = fixture();
		await f.initialize();
		await f.makeFlow().purchase(intent, async () => transaction);
		const controller = new AbortController();
		f.getPurchaseAttempt.mockImplementationOnce(async () => {
			controller.abort();
			throw new Error("Backgrounded");
		});
		await expect(f.makeFlow().recover(controller.signal)).rejects.toMatchObject({
			code: "store_request_failed",
		});
		expect(f.values.size).toBe(1);
	});
});

describe("store errors and build policy", () => {
	for (const code of [
		StoreErrorCode.idempotency_key_conflict,
		StoreErrorCode.store_purchases_disabled,
		StoreErrorCode.store_environment_held,
		StoreErrorCode.store_evidence_not_converged,
	]) {
		test(`preserves typed ${code} without exposing the server message`, async () => {
			const f = fixture();
			await f.initialize();
			f.createPurchaseAttempt.mockImplementationOnce(async () => {
				throw new ApiClientError(409, code);
			});
			await expect(f.makeFlow().purchase(intent, async () => transaction)).rejects.toMatchObject({
				code,
				message: "The store purchase could not be completed",
			});
		});
	}
	test("future API codes and native error messages remain private", async () => {
		const f = fixture();
		await f.initialize();
		f.createPurchaseAttempt.mockImplementationOnce(async () => {
			throw new ApiClientError(409, "future_private_code");
		});
		await expect(f.makeFlow().purchase(intent, async () => transaction)).rejects.toMatchObject({
			code: "store_request_failed",
			message: "The store purchase could not be completed",
		});
	});
	test("production hides card-only surfaces even when keys are unset; preview/development retain Web parity", () => {
		expect(
			isStoreBuild(fixture({ environment: "production", revenueCatAppleKey: undefined }).config),
		).toBe(true);
		for (const environment of ["preview", "development", undefined])
			expect(isStoreBuild({ environment })).toBe(false);
	});
});
