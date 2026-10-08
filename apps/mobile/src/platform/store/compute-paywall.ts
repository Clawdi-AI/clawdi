import type { PurchasesOffering, PurchasesPackage } from "react-native-purchases";
import type { PresentPaywall } from "./paywall-host";
import type { PurchaseOutcome } from "./purchase-flow";
import type { StoreTransactionHint } from "./revenuecat";
import { StorePurchaseError } from "./store-error";

/** Starts the M1 compute purchase for the package the Paywall selected. */
export type ComputePaywallPurchase = (
	selected: PurchasesPackage,
	paywall: (signal: AbortSignal) => Promise<StoreTransactionHint | null>,
) => Promise<PurchaseOutcome>;

/**
 * Presents the official Paywall for the `compute` offering. A compute attempt needs its
 * product before the purchase, so the Paywall holds its purchase of the selected package
 * (`onPurchasePackageInitiated`) until M1 has journaled and created the attempt, then
 * buys exactly that package. Resolves null when closed without choosing a package and
 * rejects with `paywall_unavailable` when the native Paywall cannot render.
 */
export function runComputePaywall({
	offering,
	present,
	signal,
	purchase,
}: {
	offering: PurchasesOffering;
	present: PresentPaywall;
	signal: AbortSignal;
	purchase: ComputePaywallPurchase;
}): Promise<PurchaseOutcome | null> {
	const controller = new AbortController();
	const abort = () => controller.abort(signal.reason);
	if (signal.aborted) abort();
	else signal.addEventListener("abort", abort, { once: true });
	return new Promise<PurchaseOutcome | null>((resolve, reject) => {
		let started = false;
		const session = present(offering, controller.signal, {
			settleOnCancel: true,
			intercept: (selected, resume) => {
				// One Paywall presentation is one purchase attempt.
				if (started) return resume(false);
				started = true;
				let resumed = false;
				purchase(selected, (purchaseSignal) => {
					resumed = true;
					purchaseSignal.addEventListener("abort", () => controller.abort(purchaseSignal.reason), {
						once: true,
					});
					resume(!purchaseSignal.aborted);
					return session.result;
				})
					.then(resolve, reject)
					.finally(() => {
						// The attempt was refused before the purchase: release and close the Paywall.
						if (!resumed) {
							resume(false);
							controller.abort();
						}
					});
			},
		});
		session.result.then(
			() => {
				if (started) return;
				const failure = session.failure();
				if (failure) reject(new StorePurchaseError(failure));
				else resolve(null);
			},
			(error: unknown) => {
				if (!started) reject(error);
			},
		);
	}).finally(() => signal.removeEventListener("abort", abort));
}
