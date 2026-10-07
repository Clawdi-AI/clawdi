import {
	ApiClientError,
	type HostedStoreClient,
	readStoreErrorCode,
	type StorePlatform,
	type StorePurchaseAttempt,
	type StorePurchaseAttemptRequest,
} from "@clawdi/shared/api";
import { type AccountScope, readInAccountScope } from "@/platform/auth/account-scope";
import {
	type PurchaseAttemptStore,
	parsePurchaseAttempt,
	type SavedPurchaseAttempt,
} from "./purchase-attempt-storage";
import type { RevenueCat, StoreTransactionHint } from "./revenuecat";
import { StorePurchaseError, storePurchaseError } from "./store-error";
import { assertStoreAccount, type StoreIdentity } from "./store-identity";

export type PurchaseIntent = Pick<
	StorePurchaseAttemptRequest,
	"purpose" | "pending_deploy_request_id"
>;
export type PurchaseOutcome = Readonly<{
	status: "funding_applied" | "submitted" | "terminal" | "pending" | "cancelled";
	attempt: StorePurchaseAttempt;
}>;

export function isFinishedPurchase(state: StorePurchaseAttempt["state"]): boolean {
	return (
		state === "funding_applied" ||
		state === "canceled" ||
		state === "expired" ||
		state === "rejected" ||
		state === "reconciliation_required"
	);
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const abort = () => {
			clearTimeout(timer);
			reject(signal.reason ?? new Error("Polling cancelled"));
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", abort);
			resolve();
		}, ms);
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
	});
}

/** Domain journal + hosted settlement only. M2 supplies the official Paywall UI. */
export function createPurchaseFlow(options: {
	scope: AccountScope;
	client: HostedStoreClient;
	identity: StoreIdentity;
	sdk: RevenueCat;
	platform: StorePlatform;
	journal: PurchaseAttemptStore;
	storageKey: string;
	newKey: () => string;
	clock?: { now: () => number; sleep: (ms: number, signal: AbortSignal) => Promise<void> };
}) {
	const { scope, client, identity, sdk, platform, journal, storageKey, newKey } = options;
	const clock = options.clock ?? { now: Date.now, sleep: wait };
	let busy = false;
	const current = (signal: AbortSignal) =>
		scope.isCurrent() && !scope.signal.aborted && !signal.aborted;

	async function run<T>(
		work: (signal: AbortSignal) => Promise<T>,
		signal?: AbortSignal,
	): Promise<T> {
		try {
			return await readInAccountScope(scope, work, signal);
		} catch (error) {
			throw storePurchaseError(error);
		}
	}
	async function checkIdentity(signal: AbortSignal) {
		const ready = identity.requireReady(signal);
		await sdk.withIdentity(
			ready.appUserId,
			() => assertStoreAccount(scope, signal),
			async () => undefined,
		);
		return ready;
	}
	async function create(saved: SavedPurchaseAttempt, signal: AbortSignal) {
		assertStoreAccount(scope, signal);
		let attempt: StorePurchaseAttempt;
		try {
			attempt = saved.attemptId
				? await client.getPurchaseAttempt(saved.attemptId, signal)
				: await client.createPurchaseAttempt(saved.request, saved.key, signal);
		} catch (error) {
			assertStoreAccount(scope, signal);
			// Only an explicit typed rejection proves that creation did not succeed.
			if (
				!saved.attemptId &&
				error instanceof ApiClientError &&
				error.status >= 400 &&
				error.status < 500 &&
				readStoreErrorCode(error)
			)
				await journal.clearAttempt(storageKey, saved, () => current(signal));
			throw error;
		}
		assertStoreAccount(scope, signal);
		if (
			attempt.platform !== saved.request.platform ||
			attempt.purpose !== saved.request.purpose ||
			attempt.catalogue_revision !== saved.request.catalogue_revision ||
			(attempt.pending_deploy_request_id ?? null) !==
				(saved.request.pending_deploy_request_id ?? null)
		)
			throw new StorePurchaseError("store_attempt_conflict");
		if (!saved.attemptId) {
			const next = { ...saved, attemptId: attempt.attempt_id };
			await journal.replaceAttempt(storageKey, saved, next, () => current(signal));
			saved = next;
		}
		return { saved, attempt };
	}
	function finished(attempt: StorePurchaseAttempt, saved: SavedPurchaseAttempt | null) {
		// Expired paid attempts need one confirmation before releasing the journal.
		return (
			isFinishedPurchase(attempt.state) && !(attempt.state === "expired" && saved?.transactionHint)
		);
	}
	async function finish(
		attempt: StorePurchaseAttempt,
		saved: SavedPurchaseAttempt | null,
		signal: AbortSignal,
		submitted = false,
	): Promise<PurchaseOutcome> {
		assertStoreAccount(scope, signal);
		// A manual reconciliation hold continues blocking a second purchase.
		if (
			saved &&
			(submitted || finished(attempt, saved)) &&
			attempt.state !== "reconciliation_required"
		)
			await journal.clearAttempt(storageKey, saved, () => current(signal));
		return {
			status: submitted
				? "submitted"
				: attempt.state === "funding_applied"
					? "funding_applied"
					: finished(attempt, saved)
						? "terminal"
						: attempt.state === "prepared" && saved?.cancelled
							? "cancelled"
							: "pending",
			attempt,
		};
	}
	async function poll(
		attempt: StorePurchaseAttempt,
		saved: SavedPurchaseAttempt | null,
		signal: AbortSignal,
		deadline = clock.now() + 120_000,
	): Promise<PurchaseOutcome> {
		if (clock.now() >= deadline) return finish(attempt, saved, signal);
		const controller = new AbortController();
		let timedOut = false;
		const abort = () => controller.abort(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, deadline - clock.now());
		let delay = 2_000;
		try {
			assertStoreAccount(scope, signal);
			while (!isFinishedPurchase(attempt.state) && clock.now() < deadline) {
				await clock.sleep(Math.min(delay, deadline - clock.now()), controller.signal);
				assertStoreAccount(scope, signal);
				if (clock.now() >= deadline) break;
				attempt = await client.getPurchaseAttempt(attempt.attempt_id, controller.signal);
				assertStoreAccount(scope, signal);
				delay = Math.min(delay * 2, 30_000);
			}
		} catch (error) {
			assertStoreAccount(scope, signal);
			if (!timedOut) throw error;
		} finally {
			clearTimeout(timer);
			signal.removeEventListener("abort", abort);
		}
		if (attempt.state === "expired" && saved?.transactionHint)
			return reconcile(attempt, saved, signal, deadline);
		return finish(attempt, saved, signal);
	}
	async function reconcile(
		attempt: StorePurchaseAttempt,
		saved: SavedPurchaseAttempt | null,
		signal: AbortSignal,
		deadline?: number,
	) {
		if (
			finished(attempt, saved) ||
			(deadline !== undefined && clock.now() >= deadline && attempt.state !== "expired")
		)
			return finish(attempt, saved, signal);
		const ready = identity.requireReady(signal);
		if (!saved?.transactionHint) {
			if (attempt.state === "prepared") {
				if (!saved?.purchaseStarted) return finish(attempt, saved, signal);
				await sdk.syncPurchases(ready.appUserId, () => assertStoreAccount(scope, signal), signal);
				attempt = await client.getPurchaseAttempt(attempt.attempt_id, signal);
				assertStoreAccount(scope, signal);
			}
			// Sync is not purchase evidence. Webhooks/workers claim purchases; unpaid attempts expire.
			return poll(attempt, saved, signal, deadline);
		}
		const confirmation = await sdk.withIdentity(
			ready.appUserId,
			() => assertStoreAccount(scope, signal),
			(operationSignal) =>
				client.confirmPurchaseAttempt(
					attempt.attempt_id,
					{ store_transaction_id: saved.transactionHint },
					operationSignal,
				),
			signal,
		);
		assertStoreAccount(scope, signal);
		const confirmed = { ...attempt, state: confirmation.state };
		// Hosted credits the transaction independently; an expired attempt never becomes funded.
		if (confirmation.state === "expired") return finish(confirmed, saved, signal, true);
		return poll(confirmed, saved, signal, deadline);
	}

	return {
		isBusy: () => busy,
		/** Resolve within five minutes, after UI dismissal, with onPurchaseCompleted's transaction.
		 * Null means definitively dismissed/cancelled without purchase; deferred purchases must throw.
		 * Gate onPurchasePackageInitiated's resume with the signal, and dismiss on abort.
		 */
		purchase: async (
			intent: PurchaseIntent,
			showPaywall: (signal: AbortSignal) => Promise<StoreTransactionHint | null>,
		): Promise<PurchaseOutcome> => {
			if (busy) throw new StorePurchaseError("purchase_pending");
			busy = true;
			try {
				return await run(async (signal) => {
					const ready = await checkIdentity(signal);
					let saved = await journal.readSavedAttempt(storageKey);
					assertStoreAccount(scope, signal);
					if (saved && (saved.appUserId !== ready.appUserId || saved.request.platform !== platform))
						throw new StorePurchaseError("identity_mismatch");
					if (
						saved &&
						(saved.request.purpose !== intent.purpose ||
							(saved.request.pending_deploy_request_id ?? null) !==
								(intent.pending_deploy_request_id ?? null))
					) {
						const existing = await create(saved, signal);
						saved = existing.saved;
						if (
							isFinishedPurchase(existing.attempt.state) &&
							existing.attempt.state !== "reconciliation_required"
						) {
							const outcome = await reconcile(existing.attempt, saved, signal);
							if (
								outcome.status === "pending" ||
								outcome.attempt.state === "reconciliation_required"
							)
								throw new StorePurchaseError("purchase_pending");
							saved = null;
						} else throw new StorePurchaseError("purchase_pending");
					}
					if (!saved) {
						saved = {
							format: 1,
							key: newKey(),
							appUserId: ready.appUserId,
							request: {
								platform,
								catalogue_revision: ready.catalogueRevision,
								purpose: intent.purpose,
								pending_deploy_request_id: intent.pending_deploy_request_id ?? null,
							},
							attemptId: null,
							purchaseStarted: false,
							cancelled: false,
							transactionHint: null,
						};
						// Failure here must prevent both POST and opening the native sheet.
						if (!parsePurchaseAttempt(JSON.stringify(saved)))
							throw new StorePurchaseError("invalid_purchase_request");
						await journal.saveAttempt(storageKey, saved, () => current(signal));
					}
					const created = await create(saved, signal);
					saved = created.saved;
					if (finished(created.attempt, saved)) return finish(created.attempt, saved, signal);
					if (
						saved.purchaseStarted ||
						saved.transactionHint ||
						created.attempt.state !== "prepared"
					)
						return reconcile(created.attempt, saved, signal);
					const started = { ...saved, purchaseStarted: true, cancelled: false };
					await journal.replaceAttempt(storageKey, saved, started, () => current(signal));
					saved = started;
					const transaction = await sdk.withIdentity(
						ready.appUserId,
						() => assertStoreAccount(scope, signal),
						showPaywall,
						signal,
					);
					assertStoreAccount(scope, signal);
					if (!transaction) {
						await journal.replaceAttempt(
							storageKey,
							saved,
							{ ...saved, purchaseStarted: false, cancelled: true },
							() => current(signal),
						);
						return { status: "cancelled", attempt: created.attempt };
					}
					const hint = transaction.transactionIdentifier;
					if (typeof hint !== "string" || !hint.trim() || hint.length > 255)
						throw new StorePurchaseError("invalid_store_result");
					const purchased = { ...saved, transactionHint: hint };
					await journal.replaceAttempt(storageKey, saved, purchased, () => current(signal));
					return reconcile(created.attempt, purchased, signal);
				});
			} finally {
				busy = false;
			}
		},
		/** Start/foreground recovery never opens a paywall or starts another store charge. */
		recover: async (callerSignal?: AbortSignal): Promise<PurchaseOutcome[]> => {
			if (busy) return [];
			busy = true;
			try {
				return await run(async (signal) => {
					const ready = await checkIdentity(signal);
					const saved = await journal.readSavedAttempt(storageKey);
					const deadline = clock.now() + 120_000;
					assertStoreAccount(scope, signal);
					const results: PurchaseOutcome[] = [];
					let localId: string | null = null;
					if (saved) {
						if (saved.appUserId !== ready.appUserId || saved.request.platform !== platform)
							throw new StorePurchaseError("identity_mismatch");
						const created = await create(saved, signal);
						localId = created.attempt.attempt_id;
						results.push(
							created.saved.purchaseStarted || created.attempt.state !== "prepared"
								? await reconcile(created.attempt, created.saved, signal, deadline)
								: await finish(created.attempt, created.saved, signal),
						);
					}
					const remote = await client.listPurchaseAttempts({ state: "pending" }, signal);
					assertStoreAccount(scope, signal);
					for (const attempt of remote) {
						if (attempt.attempt_id === localId || attempt.platform !== platform) continue;
						results.push(
							attempt.state === "prepared"
								? await finish(attempt, null, signal)
								: await reconcile(attempt, null, signal, deadline),
						);
					}
					return results;
				}, callerSignal);
			} finally {
				busy = false;
			}
		},
	};
}

export type PurchaseFlow = ReturnType<typeof createPurchaseFlow>;
