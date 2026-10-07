import { describe, expect, mock, test } from "bun:test";
import type { PurchasesError, PurchasesStoreTransaction } from "react-native-purchases";

mock.module("react-native-purchases", () => ({
	default: {
		PURCHASES_ERROR_CODE: { PURCHASE_CANCELLED_ERROR: "1", PAYMENT_PENDING_ERROR: "20" },
	},
}));
const { createPaywallSession } = await import("./paywall-session");

const storeTransaction = {
	transactionIdentifier: "GPA.0000-0000",
} as PurchasesStoreTransaction;
const purchaseError = (code: string) => ({ error: { code } as PurchasesError });

function session(settleGraceMs?: number) {
	const controller = new AbortController();
	const close = mock(() => undefined);
	const value = createPaywallSession(controller.signal, close, settleGraceMs);
	return { controller, close, ...value };
}
function initiate(s: ReturnType<typeof session>) {
	const resume = mock((_proceed: boolean) => undefined);
	s.listeners.onPurchasePackageInitiated({ resume });
	return resume;
}

describe("Paywall session (M1 showPaywall contract)", () => {
	test("resolves the completed transaction only after the Paywall dismisses", async () => {
		const s = session();
		expect(initiate(s)).toHaveBeenCalledWith(true);
		s.listeners.onPurchaseStarted();
		s.listeners.onPurchaseCompleted({ storeTransaction });
		expect(s.close).not.toHaveBeenCalled();
		s.listeners.onDismiss();
		expect(await s.result).toEqual({ transactionIdentifier: "GPA.0000-0000" });
		expect(s.close).toHaveBeenCalledTimes(1);
	});

	test("resolves null only for a definitive dismissal or cancellation without purchase", async () => {
		const dismissed = session();
		dismissed.listeners.onDismiss();
		expect(await dismissed.result).toBeNull();

		const cancelled = session();
		initiate(cancelled);
		cancelled.listeners.onPurchaseCancelled();
		expect(cancelled.close).not.toHaveBeenCalled();
		cancelled.listeners.onDismiss();
		expect(await cancelled.result).toBeNull();

		const cancelledError = session();
		initiate(cancelledError);
		cancelledError.listeners.onPurchaseError(purchaseError("1"));
		cancelledError.listeners.onDismiss();
		expect(await cancelledError.result).toBeNull();
	});

	test("Ask-to-Buy / Play PENDING rejects and never resolves null", async () => {
		const s = session();
		initiate(s);
		s.listeners.onPurchaseError(purchaseError("20"));
		s.listeners.onPurchaseCancelled();
		s.listeners.onDismiss();
		await expect(s.result).rejects.toMatchObject({ code: "payment_pending" });
	});

	test("an unconfirmed native error rejects unless a later purchase completes", async () => {
		const failed = session();
		initiate(failed);
		failed.listeners.onPurchaseError(purchaseError("2"));
		failed.listeners.onDismiss();
		await expect(failed.result).rejects.toMatchObject({ code: "purchase_unconfirmed" });

		const retried = session();
		initiate(retried);
		retried.listeners.onPurchaseError(purchaseError("2"));
		initiate(retried);
		retried.listeners.onPurchaseCompleted({ storeTransaction });
		retried.listeners.onDismiss();
		expect(await retried.result).toEqual({ transactionIdentifier: "GPA.0000-0000" });
	});

	test("abort blocks new purchases and closes the UI immediately when idle", async () => {
		const s = session();
		const reason = new Error("account changed");
		s.controller.abort(reason);
		expect(initiate(s)).toHaveBeenCalledWith(false);
		await expect(s.result).rejects.toBe(reason);
		expect(s.close).toHaveBeenCalledTimes(1);
	});

	test("abort during a native purchase waits for it to settle before closing", async () => {
		const s = session();
		initiate(s);
		let settled = false;
		void s.result.catch(() => {
			settled = true;
		});
		s.controller.abort(new Error("timeout"));
		await Promise.resolve();
		expect(settled).toBe(false);
		expect(s.close).not.toHaveBeenCalled();
		s.requestClose();
		expect(s.close).not.toHaveBeenCalled();
		s.listeners.onPurchaseCompleted({ storeTransaction });
		await expect(s.result).rejects.toThrow("timeout");
		expect(s.close).toHaveBeenCalledTimes(1);
	});

	test("abort settles within the grace period if native work never reports back", async () => {
		const s = session(5);
		initiate(s);
		s.controller.abort(new Error("timeout"));
		await expect(s.result).rejects.toThrow("timeout");
		expect(s.close).toHaveBeenCalledTimes(1);
	});

	test("a Paywall render failure is a definitive no-purchase with a visible reason", async () => {
		const s = session();
		s.failRender();
		expect(await s.result).toBeNull();
		expect(s.failure()).toBe("paywall_unavailable");
	});
});
