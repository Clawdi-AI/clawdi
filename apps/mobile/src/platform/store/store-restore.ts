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
