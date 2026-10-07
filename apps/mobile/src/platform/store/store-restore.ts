import type { HostedStoreClient, StoreComputeReconcileResponse } from "@clawdi/shared/api";
import { type AccountScope, readInAccountScope } from "@/platform/auth/account-scope";
import { assertStoreAccount, type StoreIdentity } from "./store-identity";

type RestoreSdk = {
	restorePurchases: (
		appUserId: string,
		assertCurrent: () => void,
		signal: AbortSignal,
	) => Promise<unknown>;
};
type RestoreIdentity = Pick<StoreIdentity, "requireReady">;
type RestoreClient = Pick<HostedStoreClient, "reconcileComputeSubscriptions">;

/** A response without compute_slot carries no new slot observation. */
export function restoredComputeSlot(
	previous: StoreComputeReconcileResponse["compute_slot"] | null | undefined,
	response: Pick<StoreComputeReconcileResponse, "compute_slot">,
): NonNullable<StoreComputeReconcileResponse["compute_slot"]> | null {
	return Object.hasOwn(response, "compute_slot")
		? (response.compute_slot ?? null)
		: (previous ?? null);
}

/** Restore updates only observations returned by Hosted; startup state stays visible. */
export function preserveRestoreState<TRecovery, TError>(
	previous: Readonly<{
		computeSlot: NonNullable<StoreComputeReconcileResponse["compute_slot"]> | null;
		recovery: TRecovery;
		error: TError;
	}>,
	response: Pick<StoreComputeReconcileResponse, "compute_slot">,
): Readonly<{
	computeSlot: NonNullable<StoreComputeReconcileResponse["compute_slot"]> | null;
	recovery: TRecovery;
	error: TError;
}> {
	return {
		...previous,
		computeSlot: restoredComputeSlot(previous.computeSlot, response),
	};
}

/** Restores native purchases, then asks Hosted to reconcile every subscription. */
export function restoreStorePurchases(options: {
	scope: AccountScope;
	identity: RestoreIdentity;
	sdk: RestoreSdk;
	client: RestoreClient;
	signal?: AbortSignal;
}): Promise<StoreComputeReconcileResponse> {
	const { scope, identity, sdk, client, signal: callerSignal } = options;
	return readInAccountScope(
		scope,
		async (signal) => {
			const ready = identity.requireReady(signal);
			await sdk.restorePurchases(ready.appUserId, () => assertStoreAccount(scope, signal), signal);
			const result = await client.reconcileComputeSubscriptions(signal);
			assertStoreAccount(scope, signal);
			return result;
		},
		callerSignal,
	);
}
