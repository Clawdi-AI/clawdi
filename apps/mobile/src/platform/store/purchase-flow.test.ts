import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
	ApiClientError,
	type HostedStoreClient,
	type StoreComputeReconcileResponse,
	StoreErrorCode,
	type StorePurchaseAttempt,
	type StorePurchaseAttemptRequest,
	type StorePurchaseConfirmation,
} from "@clawdi/shared/api";
import type { MobileRuntimeConfig } from "@/lib/config/runtime-config";
import { createAccountScope } from "@/platform/auth/account-scope";
import { createPurchaseAttemptStore, parsePurchaseAttempt } from "./purchase-attempt-storage";
import { StorePurchaseError } from "./store-error";
import { isStoreBuild } from "./store-policy";
import { recoverStoreFlow } from "./store-recovery";

const appUserId = "11111111-1111-4111-8111-111111111111";
const otherAppUserId = "22222222-2222-4222-8222-222222222222";
const attemptId = "33333333-3333-4333-8333-333333333333";
let sdkUserId = appUserId;
const configure = mock((options: { appUserID: string }) => {
	sdkUserId = options.appUserID;
});
const logIn = mock(async (id: string) => {
	sdkUserId = id;
	return {};
});
const logOut = mock(async () => {
	sdkUserId = "$RCAnonymousID:test";
	return {};
});
const getAppUserID = mock(async () => sdkUserId);
const syncPurchases = mock(async () => {});
const getOfferings = mock(async (): Promise<unknown> => ({ all: {}, current: null }));
// Shared shape: Bun keeps one module mock for every store test file.
mock.module("react-native-purchases", () => ({
	default: {
		configure,
		logIn,
		logOut,
		getAppUserID,
		syncPurchases,
		getOfferings,
		PURCHASES_ERROR_CODE: { PURCHASE_CANCELLED_ERROR: "1", PAYMENT_PENDING_ERROR: "20" },
	},
}));
const { createRevenueCat, loadCreditsOffering, revenueCatKey } = await import("./revenuecat");
const { createStoreIdentity } = await import("./store-identity");
const { createPurchaseFlow } = await import("./purchase-flow");

beforeEach(() => {
	sdkUserId = appUserId;
	for (const fn of [configure, logIn, logOut, getAppUserID, syncPurchases]) fn.mockClear();
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

function fixture(configOverrides: Partial<MobileRuntimeConfig> = {}, identityTimeoutMs = 300_000) {
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
		compute_subscriptions_enabled: false,
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
		async (
			id: string,
			_body: { store_transaction_id?: string | null } = {},
		): Promise<StorePurchaseConfirmation> => {
			expect(id).toBe(attemptId);
			return { state: "verification_pending" as const, correlation_id: "safe-correlation" };
		},
	);
	const getPurchaseAttempt = mock(async () => attempt);
	const listPurchaseAttempts = mock(async () => [] as StorePurchaseAttempt[]);
	const reconcileComputeSubscriptions = mock(
		async (): Promise<StoreComputeReconcileResponse> => ({
			code: "reconciliation_pending",
			compute_slot: null,
			results: [],
		}),
	);
	const client: HostedStoreClient = {
		bootstrap,
		createPurchaseAttempt,
		confirmPurchaseAttempt,
		getPurchaseAttempt,
		listPurchaseAttempts,
		reconcileComputeSubscriptions,
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
	const sdk = createRevenueCat(identityTimeoutMs);
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
		advanceTime: (ms: number) => {
			time += ms;
		},
		initialize: () => identity.initialize(scope.signal),
		setAttempt: (state: StorePurchaseAttempt["state"]) => {
			attempt = { ...attempt, state };
		},
		setAttemptFields: (fields: Partial<StorePurchaseAttempt>) => {
			attempt = { ...attempt, ...fields };
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
	test("sign-out fences purchases while preserving SDK identity until the next bootstrap", async () => {
		const f = fixture();
		expect((await f.initialize()).available).toBe(true);
		await f.initialize();
		expect(configure).toHaveBeenCalledTimes(1);
		expect(logIn).toHaveBeenCalledWith(appUserId);
		f.switchAccount();
		await expect(f.makeFlow().purchase(intent, async () => transaction)).rejects.toMatchObject({
			code: "account_changed",
		});
		expect(logOut).not.toHaveBeenCalled();
		expect(sdkUserId).toBe(appUserId);
	});
	test("disabled bootstrap with null identity never touches SDK or opens a paywall", async () => {
		const f = fixture();
		f.client.bootstrap = async () => ({
			purchases_enabled: false,
			compute_subscriptions_enabled: false,
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
		expect(logOut).not.toHaveBeenCalled();
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
					compute_subscriptions_enabled: false,
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
	test("a paywall timeout keeps the next account login locked until native work settles", async () => {
		const f = fixture({}, 30);
		await f.initialize();
		const opened = deferred<AbortSignal>();
		const result = deferred<typeof transaction>();
		const pending = f.makeFlow().purchase(intent, async (signal) => {
			opened.resolve(signal);
			return result.promise;
		});
		const paywallSignal = await opened.promise;
		f.switchAccount();
		expect(paywallSignal.aborted).toBe(true);
		const nextLogin = f.sdk.logIn("public-sdk-key", otherAppUserId, () => {});
		await expect(pending).rejects.toMatchObject({ code: "account_changed" });
		expect(logIn).toHaveBeenCalledTimes(1);
		expect(sdkUserId).toBe(appUserId);
		result.resolve(transaction);
		await nextLogin;
		expect(sdkUserId).toBe(otherAppUserId);
		expect(f.confirmPurchaseAttempt).not.toHaveBeenCalled();
		expect(parsePurchaseAttempt(f.values.get("journal") ?? "")?.transactionHint).toBeNull();
	});
	test("paywall timeout aborts M2's signal and keeps uncertain purchase evidence", async () => {
		const f = fixture({}, 30);
		await f.initialize();
		const opened = deferred<AbortSignal>();
		const result = deferred<typeof transaction>();
		const flow = f.makeFlow();
		const pending = flow.purchase(intent, async (signal) => {
			opened.resolve(signal);
			return result.promise;
		});
		const signal = await opened.promise;
		await expect(pending).rejects.toMatchObject({ code: "store_operation_timeout" });
		expect(signal.aborted).toBe(true);
		expect(flow.isBusy()).toBe(false);
		expect(parsePurchaseAttempt(f.values.get("journal") ?? "")?.purchaseStarted).toBe(true);
		const nextLogin = f.sdk.logIn("public-sdk-key", otherAppUserId, () => {});
		await Promise.resolve();
		expect(logIn).toHaveBeenCalledTimes(1);
		expect(sdkUserId).toBe(appUserId);
		result.resolve(transaction);
		await nextLogin;
		expect(f.confirmPurchaseAttempt).not.toHaveBeenCalled();
	});
	test("a late SDK identity check cannot open a paywall after its timeout", async () => {
		const f = fixture({}, 30);
		await f.initialize();
		const checked = deferred<string>();
		getAppUserID.mockImplementationOnce(async () => checked.promise);
		const paywall = mock(async () => transaction);
		await expect(f.sdk.withIdentity(appUserId, () => {}, paywall)).rejects.toMatchObject({
			code: "store_operation_timeout",
		});
		const nextLogin = f.sdk.logIn("public-sdk-key", otherAppUserId, () => {});
		await Promise.resolve();
		expect(logIn).toHaveBeenCalledTimes(1);
		checked.resolve(appUserId);
		await nextLogin;
		expect(paywall).not.toHaveBeenCalled();
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
		expect(f.confirmPurchaseAttempt).not.toHaveBeenCalled();
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
		expect(f.confirmPurchaseAttempt).not.toHaveBeenCalled();
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
		const next = { ...previous, purchaseStarted: true, cancelled: false };
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
			compute_subscriptions_enabled: false,
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
	test("credits recovery ignores the hosted product echo", async () => {
		const f = fixture();
		await f.initialize();
		await expect(
			f.makeFlow().purchase(intent, async () => {
				throw new Error("App terminated after credit purchase");
			}),
		).rejects.toMatchObject({ code: "store_request_failed" });
		f.setAttemptFields({ store_product_id: "ai.clawdi.app.credits.10" });
		f.setAttempt("funding_applied");
		expect((await f.makeFlow().recover())[0]?.status).toBe("funding_applied");
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
		expect(f.confirmPurchaseAttempt).not.toHaveBeenCalled();
		expect(syncPurchases).toHaveBeenCalledTimes(1);
		expect(parsePurchaseAttempt(f.values.get("journal") ?? "")?.purchaseStarted).toBe(true);
	});
	test("restart syncs an interrupted prepared purchase and only reads until the unpaid attempt expires", async () => {
		const f = fixture();
		await f.initialize();
		await expect(
			f.makeFlow().purchase(intent, async () => {
				throw new Error("App stopped during the paywall");
			}),
		).rejects.toMatchObject({ code: "store_request_failed" });
		syncPurchases.mockImplementationOnce(async () => f.setAttempt("expired"));
		expect((await f.makeFlow().recover())[0]?.status).toBe("terminal");
		expect(syncPurchases).toHaveBeenCalledTimes(1);
		expect(f.getPurchaseAttempt).toHaveBeenCalledTimes(2);
		expect(f.confirmPurchaseAttempt).not.toHaveBeenCalled();
		expect(f.values.size).toBe(0);
	});
	test("sync can discover a real purchase claimed by the server without client confirmation", async () => {
		const f = fixture();
		await f.initialize();
		await expect(
			f.makeFlow().purchase(intent, async () => {
				throw new Error("Deferred purchase");
			}),
		).rejects.toMatchObject({ code: "store_request_failed" });
		syncPurchases.mockImplementationOnce(async () => f.setAttempt("funding_applied"));
		expect((await f.makeFlow().recover())[0]?.status).toBe("funding_applied");
		expect(f.confirmPurchaseAttempt).not.toHaveBeenCalled();
		expect(f.values.size).toBe(0);
	});
	test("recovery preserves cancelled prepared status across restart and retries the same intent", async () => {
		const f = fixture();
		await f.initialize();
		await f.makeFlow().purchase(intent, async () => null);
		expect(parsePurchaseAttempt(f.values.get("journal") ?? "")?.cancelled).toBe(true);
		expect((await f.makeFlow().recover())[0]?.status).toBe("cancelled");
		expect(syncPurchases).not.toHaveBeenCalled();
		expect(f.confirmPurchaseAttempt).not.toHaveBeenCalled();
		await f.makeFlow().purchase(intent, async () => transaction);
		expect(parsePurchaseAttempt(f.values.get("journal") ?? "")?.cancelled).toBe(false);
		expect(f.newKey).toHaveBeenCalledTimes(1);
	});
	test("flow keeps native pending distinct from explicit cancellation", async () => {
		const pending = fixture();
		await pending.initialize();
		await expect(
			pending.makeFlow().purchase(intent, async () => {
				throw new StorePurchaseError("payment_pending");
			}),
		).rejects.toMatchObject({ code: "payment_pending" });
		expect(parsePurchaseAttempt(pending.values.get("journal") ?? "")?.purchaseStarted).toBe(true);

		const cancelled = fixture();
		await cancelled.initialize();
		const outcome = await cancelled.makeFlow().purchase(intent, async () => null);
		expect(outcome.status).toBe("cancelled");
		expect(parsePurchaseAttempt(cancelled.values.get("journal") ?? "")?.cancelled).toBe(true);
	});
	test("recovery confirms expired paid evidence once, returns submitted and releases the journal", async () => {
		const f = fixture();
		await f.initialize();
		f.confirmPurchaseAttempt.mockImplementationOnce(async () => {
			throw new Error("Lost confirmation");
		});
		await expect(f.makeFlow().purchase(intent, async () => transaction)).rejects.toMatchObject({
			code: "store_request_failed",
		});
		f.setAttempt("expired");
		// A slow read can consume the polling budget; expired evidence still submits once.
		f.getPurchaseAttempt.mockImplementationOnce(async () => {
			f.advanceTime(120_000);
			return { ...(await f.getPurchaseAttempt()), state: "expired" };
		});
		f.confirmPurchaseAttempt.mockClear();
		f.confirmPurchaseAttempt.mockImplementationOnce(async () => ({
			state: "expired",
			correlation_id: "safe-correlation",
		}));
		const outcome = (await f.makeFlow().recover())[0];
		expect(outcome?.status).toBe("submitted");
		expect(outcome?.attempt.state).toBe("expired");
		expect(f.confirmPurchaseAttempt.mock.calls[0]?.[1]).toEqual({
			store_transaction_id: transaction.transactionIdentifier,
		});
		expect(f.values.size).toBe(0);
		expect(await f.makeFlow().recover()).toEqual([]);
		expect(f.confirmPurchaseAttempt).toHaveBeenCalledTimes(1);
		expect(f.delays).toEqual([]);
	});
	test("paid expiry returns submitted without polling or blocking the next purchase purpose", async () => {
		const f = fixture();
		await f.initialize();
		f.confirmPurchaseAttempt.mockImplementation(async () => ({
			state: "expired",
			correlation_id: "safe-correlation",
		}));
		// Save paid evidence while the server expires the prepared attempt during the paywall.
		f.setAttempt("prepared");
		const paywall = async () => {
			f.setAttempt("expired");
			return transaction;
		};
		const outcome = await f.makeFlow().purchase(intent, paywall);
		expect(outcome.status).toBe("submitted");
		expect(outcome.attempt.state).toBe("expired");
		expect(f.confirmPurchaseAttempt).toHaveBeenCalledTimes(1);
		expect(f.values.size).toBe(0);
		expect(f.delays).toEqual([]);
		expect(await f.makeFlow().recover()).toEqual([]);
		expect(f.confirmPurchaseAttempt).toHaveBeenCalledTimes(1);
		f.createPurchaseAttempt.mockImplementationOnce(async (body) => ({
			...body,
			attempt_id: otherAppUserId,
			state: "prepared",
			expires_at: "2099-01-01T00:00:00Z",
		}));
		const next = await f
			.makeFlow()
			.purchase(
				{ purpose: "deploy_continuation", pending_deploy_request_id: "target" },
				async () => null,
			);
		expect(next.status).toBe("cancelled");
		expect(f.newKey).toHaveBeenCalledTimes(2);
	});
	test("55P03 becomes verification_pending then expired without a confirmation loop", async () => {
		const f = fixture();
		await f.initialize();
		// Hosted maps 55P03 lock contention to this acknowledgement on every confirm.
		f.confirmPurchaseAttempt.mockImplementation(async () => {
			f.setAttempt("expired");
			return {
				state: "verification_pending",
				code: "reconciliation_pending",
				correlation_id: "safe-correlation",
			};
		});
		expect((await f.makeFlow().purchase(intent, async () => transaction)).status).toBe("submitted");
		expect(f.confirmPurchaseAttempt).toHaveBeenCalledTimes(1);
		expect(f.delays).toEqual([2000]);
		expect(f.values.size).toBe(0);
	});
	test("purchase confirmation and polling consume one fixed overall deadline", async () => {
		const f = fixture();
		await f.initialize();
		f.confirmPurchaseAttempt.mockImplementationOnce(async () => {
			f.advanceTime(60_000);
			return { state: "verification_pending", correlation_id: "safe-correlation" };
		});
		expect((await f.makeFlow().purchase(intent, async () => transaction)).status).toBe("pending");
		expect(f.delays).toEqual([2000, 4000, 8000, 16000, 30000]);
		expect(f.delays.reduce((total, delay) => total + delay, 0)).toBe(60_000);
		expect(f.confirmPurchaseAttempt).toHaveBeenCalledTimes(1);
		expect(f.values.size).toBe(1);
	});
	test("a different purpose submits the old expired paid evidence before preparing a new purchase", async () => {
		const f = fixture();
		await f.initialize();
		f.confirmPurchaseAttempt.mockImplementationOnce(async () => {
			throw new Error("Lost confirmation");
		});
		await expect(f.makeFlow().purchase(intent, async () => transaction)).rejects.toMatchObject({
			code: "store_request_failed",
		});
		f.setAttempt("expired");
		f.confirmPurchaseAttempt.mockClear();
		f.confirmPurchaseAttempt.mockImplementationOnce(async () => ({
			state: "expired",
			correlation_id: "safe-correlation",
		}));
		f.createPurchaseAttempt.mockImplementationOnce(async (body) => ({
			...body,
			attempt_id: otherAppUserId,
			state: "prepared",
			expires_at: "2099-01-01T00:00:00Z",
		}));
		const result = await f
			.makeFlow()
			.purchase(
				{ purpose: "deploy_continuation", pending_deploy_request_id: "target" },
				async () => null,
			);
		expect(result.status).toBe("cancelled");
		expect(f.confirmPurchaseAttempt).toHaveBeenCalledTimes(1);
		expect(f.confirmPurchaseAttempt.mock.calls[0]?.[1]).toEqual({
			store_transaction_id: transaction.transactionIdentifier,
		});
		expect(parsePurchaseAttempt(f.values.get("journal") ?? "")?.request.purpose).toBe(
			"deploy_continuation",
		);
		expect(f.newKey).toHaveBeenCalledTimes(2);
	});
	for (const state of [
		"expired",
		"canceled",
		"funding_applied",
		"rejected",
		"reconciliation_required",
		"prepared",
	] as const) {
		test(`a different purpose reads the ${state} attempt before ${state === "prepared" || state === "reconciliation_required" ? "blocking" : "releasing the journal"}`, async () => {
			const f = fixture();
			await f.initialize();
			await f.makeFlow().purchase(intent, async () => null);
			f.setAttempt(state);
			f.newKey.mockReturnValueOnce("new-purpose-key");
			f.createPurchaseAttempt.mockImplementationOnce(async (body) => ({
				...body,
				attempt_id: otherAppUserId,
				state: "prepared",
				expires_at: "2099-01-01T00:00:00Z",
			}));
			const paywall = mock(async () => null);
			const purchase = f
				.makeFlow()
				.purchase({ purpose: "deploy_continuation", pending_deploy_request_id: "target" }, paywall);
			if (state === "prepared" || state === "reconciliation_required") {
				await expect(purchase).rejects.toMatchObject({ code: "purchase_pending" });
				expect(paywall).not.toHaveBeenCalled();
				expect(f.newKey).toHaveBeenCalledTimes(1);
			} else {
				expect((await purchase).status).toBe("cancelled");
				expect(parsePurchaseAttempt(f.values.get("journal") ?? "")?.key).toBe("new-purpose-key");
				expect(paywall).toHaveBeenCalledTimes(1);
			}
			expect(f.getPurchaseAttempt).toHaveBeenCalledTimes(1);
		});
	}
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
		StoreErrorCode.catalogue_revision_stale,
		StoreErrorCode.open_refund_debt,
		StoreErrorCode.store_identity_tombstoned,
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
			expect(f.values.size).toBe(0);
			expect((await f.makeFlow().purchase(intent, async () => null)).status).toBe("cancelled");
			expect(f.newKey).toHaveBeenCalledTimes(2);
		});
		test(`recovering an explicit ${code} create rejection clears the journal and leaves the flow usable`, async () => {
			const f = fixture();
			await f.initialize();
			const flow = f.makeFlow();
			f.createPurchaseAttempt.mockImplementationOnce(async () => {
				throw new Error("Lost create response");
			});
			await expect(flow.purchase(intent, async () => null)).rejects.toMatchObject({
				code: "store_request_failed",
			});
			f.createPurchaseAttempt.mockImplementationOnce(async () => {
				throw new ApiClientError(409, code);
			});
			const recovered = await recoverStoreFlow(flow, f.scope.signal);
			expect(recovered.flow).toBe(flow);
			expect(recovered.error?.code).toBe(code);
			expect(f.values.size).toBe(0);
			expect((await recovered.flow.purchase(intent, async () => null)).status).toBe("cancelled");
			expect(f.newKey).toHaveBeenCalledTimes(2);
		});
	}
	for (const [label, error] of [
		["network", new Error("Connection lost")],
		["5xx with a typed code", new ApiClientError(503, StoreErrorCode.store_purchases_disabled)],
		["unknown 4xx", new ApiClientError(409, "future_private_code")],
	] as const) {
		test(`uncertain ${label} create failure retains the original key through recovery and retry`, async () => {
			const f = fixture();
			await f.initialize();
			const flow = f.makeFlow();
			f.createPurchaseAttempt.mockImplementationOnce(async () => {
				throw error;
			});
			await expect(flow.purchase(intent, async () => null)).rejects.toBeDefined();
			const saved = f.values.get("journal");
			f.createPurchaseAttempt.mockImplementationOnce(async () => {
				throw error;
			});
			const recovered = await recoverStoreFlow(flow, f.scope.signal);
			expect(recovered.flow).toBe(flow);
			expect(recovered.error).not.toBeNull();
			expect(f.values.get("journal")).toBe(saved);
			expect((await recovered.flow.purchase(intent, async () => null)).status).toBe("cancelled");
			expect(f.newKey).toHaveBeenCalledTimes(1);
			expect(f.createPurchaseAttempt.mock.calls.map((call) => call[1])).toEqual([
				"persisted-idempotency-key",
				"persisted-idempotency-key",
				"persisted-idempotency-key",
			]);
		});
	}
	test("a typed read failure for an already-created attempt preserves the journal and flow", async () => {
		const f = fixture();
		await f.initialize();
		const flow = f.makeFlow();
		await flow.purchase(intent, async () => null);
		const saved = f.values.get("journal");
		f.getPurchaseAttempt.mockImplementationOnce(async () => {
			throw new ApiClientError(409, StoreErrorCode.store_attempt_unavailable);
		});
		const recovered = await recoverStoreFlow(flow, f.scope.signal);
		expect(recovered.flow).toBe(flow);
		expect(recovered.error?.code).toBe(StoreErrorCode.store_attempt_unavailable);
		expect(f.values.get("journal")).toBe(saved);
		expect((await recovered.flow.purchase(intent, async () => null)).status).toBe("cancelled");
	});
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
	test("the credits offering must exist with packages", async () => {
		const offering = (packages: number) => ({
			identifier: "credits",
			availablePackages: Array.from({ length: packages }, () => ({})),
		});
		getOfferings.mockImplementationOnce(async () => ({
			all: { credits: offering(4) },
			current: null,
		}));
		expect((await loadCreditsOffering()).identifier).toBe("credits");
		for (const result of [
			async () => ({ all: {}, current: null }),
			async () => ({ all: { credits: offering(0) }, current: null }),
			async () => {
				throw new Error("There is an issue with your configuration");
			},
		]) {
			getOfferings.mockImplementationOnce(result);
			await expect(loadCreditsOffering()).rejects.toMatchObject({
				code: "store_offering_unavailable",
			});
		}
	});
	test("production hides card-only surfaces even when keys are unset; preview/development retain Web parity", () => {
		expect(
			isStoreBuild(fixture({ environment: "production", revenueCatAppleKey: undefined }).config),
		).toBe(true);
		for (const environment of ["preview", "development", undefined])
			expect(isStoreBuild({ environment })).toBe(false);
	});
});
