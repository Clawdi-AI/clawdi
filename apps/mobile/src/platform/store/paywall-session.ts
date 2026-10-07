import Purchases, {
	type PurchasesError,
	type PurchasesStoreTransaction,
} from "react-native-purchases";
import type { StoreTransactionHint } from "./revenuecat";
import { type PurchaseErrorCode, StorePurchaseError } from "./store-error";

/** Paywall listeners, matching `<RevenueCatUI.Paywall>` props. */
type PaywallListeners = Readonly<{
	onPurchasePackageInitiated: (event: { resume: (shouldResume: boolean) => void }) => void;
	onPurchaseStarted: () => void;
	onPurchaseCompleted: (event: { storeTransaction: PurchasesStoreTransaction }) => void;
	onPurchaseError: (event: { error: PurchasesError }) => void;
	onPurchaseCancelled: () => void;
	onDismiss: () => void;
}>;

export type PaywallSession = Readonly<{
	result: Promise<StoreTransactionHint | null>;
	listeners: PaywallListeners;
	/** Back/close request from the host. Ignored while a native purchase is in flight. */
	requestClose: () => void;
	/** The native Paywall could not render, so no purchase was possible. */
	failRender: () => void;
	/** Why a null result was not a user dismissal, if known. */
	failure: () => PurchaseErrorCode | null;
}>;

/**
 * Turns one official Paywall presentation into the M1 `showPaywall` result.
 * Resolves with the completed transaction only after dismissal, resolves null only
 * for a definitive dismissal without a purchase, and rejects for Ask-to-Buy/Play
 * PENDING or any other unconfirmed native purchase so M1 keeps its start marker.
 * Abort closes the UI after native work settles, bounded by `settleGraceMs`.
 */
export function createPaywallSession(
	signal: AbortSignal,
	close: () => void,
	settleGraceMs = 30_000,
): PaywallSession {
	let inFlight = false;
	let transaction: StoreTransactionHint | null = null;
	let uncertain: PurchaseErrorCode | null = null;
	let failure: PurchaseErrorCode | null = null;
	let settled = false;
	let grace: ReturnType<typeof setTimeout> | null = null;
	let resolve: (value: StoreTransactionHint | null) => void = () => undefined;
	let reject: (error: unknown) => void = () => undefined;
	const result = new Promise<StoreTransactionHint | null>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	const settle = (outcome: { value: StoreTransactionHint | null } | { error: unknown }) => {
		if (settled) return;
		settled = true;
		if (grace) clearTimeout(grace);
		signal.removeEventListener("abort", onAbort);
		close();
		if ("error" in outcome) reject(outcome.error);
		else resolve(outcome.value);
	};
	const abortError = () => signal.reason ?? new StorePurchaseError("store_operation_timeout");
	function onAbort() {
		// Close only after the native purchase reports back, within a bounded grace period.
		if (!inFlight) settle({ error: abortError() });
		else grace = setTimeout(() => settle({ error: abortError() }), settleGraceMs);
	}
	const nativeSettled = () => {
		inFlight = false;
		if (signal.aborted) settle({ error: abortError() });
	};
	if (signal.aborted) onAbort();
	else signal.addEventListener("abort", onAbort, { once: true });

	const dismiss = () => {
		if (transaction) settle({ value: transaction });
		else if (inFlight || uncertain)
			settle({ error: new StorePurchaseError(uncertain ?? "purchase_unconfirmed") });
		else settle({ value: null });
	};
	return {
		result,
		listeners: {
			onPurchasePackageInitiated: ({ resume }) => {
				const proceed = !settled && !signal.aborted;
				if (proceed) inFlight = true;
				resume(proceed);
			},
			onPurchaseStarted: () => {
				inFlight = true;
			},
			onPurchaseCompleted: ({ storeTransaction }) => {
				transaction = { transactionIdentifier: storeTransaction.transactionIdentifier };
				uncertain = null;
				nativeSettled();
			},
			onPurchaseError: ({ error }) => {
				const { PURCHASES_ERROR_CODE } = Purchases;
				if (error.code === PURCHASES_ERROR_CODE.PURCHASE_CANCELLED_ERROR) return nativeSettled();
				// Deferred and failed purchases are not proof that no charge happened.
				uncertain =
					error.code === PURCHASES_ERROR_CODE.PAYMENT_PENDING_ERROR
						? "payment_pending"
						: (uncertain ?? "purchase_unconfirmed");
				nativeSettled();
			},
			onPurchaseCancelled: nativeSettled,
			onDismiss: dismiss,
		},
		requestClose: () => {
			if (!inFlight) dismiss();
		},
		failRender: () => {
			if (inFlight || transaction || uncertain) dismiss();
			else {
				failure = "paywall_unavailable";
				settle({ value: null });
			}
		},
		failure: () => failure,
	};
}
