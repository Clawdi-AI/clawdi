import type { PurchaseFlow, PurchaseOutcome } from "./purchase-flow";
import { type StorePurchaseError, storePurchaseError } from "./store-error";

/** Recovery failures are retryable; bootstrap availability and the flow stay intact. */
export async function recoverStoreFlow(
	flow: PurchaseFlow,
	signal: AbortSignal,
): Promise<{
	flow: PurchaseFlow;
	recovery: PurchaseOutcome[];
	error: StorePurchaseError | null;
}> {
	try {
		return { flow, recovery: await flow.recover(signal), error: null };
	} catch (error) {
		return { flow, recovery: [], error: storePurchaseError(error) };
	}
}
