import type { HostedStoreClient, StorePlatform } from "@clawdi/shared/api";
import {
	type CreationAttempt,
	storeFundingAfterCheck,
	unboundStoreSlotPlan,
} from "./deploy-request";

/** Observe hosted funding without syncing the SDK, confirming attempts or polling. */
export async function readHostedStoreFunding(
	client: HostedStoreClient,
	platform: StorePlatform,
	saved: CreationAttempt,
	productPlan: (productId: string) => string | null,
	signal: AbortSignal,
) {
	if (!saved.storeFunding) return null;
	const [attempts, bootstrap] = await Promise.all([
		client.listPurchaseAttempts(undefined, signal),
		client.bootstrap(platform, signal),
	]);
	return storeFundingAfterCheck(
		saved.id,
		attempts,
		saved.storeFunding,
		saved.draft.computePlanSlug,
		unboundStoreSlotPlan(bootstrap.compute_slot, productPlan),
	);
}
