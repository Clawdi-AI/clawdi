import { describe, expect, mock, test } from "bun:test";
import type { StorePurchaseAttempt } from "@clawdi/shared/api";
import type {
	PurchasesOffering,
	PurchasesPackage,
	PurchasesStoreTransaction,
} from "react-native-purchases";

mock.module("react-native-purchases", () => ({
	default: {
		PURCHASES_ERROR_CODE: { PURCHASE_CANCELLED_ERROR: "1", PAYMENT_PENDING_ERROR: "20" },
	},
}));
const { createPaywallSession } = await import("./paywall-session");
const { runComputePaywall } = await import("./compute-paywall");
type PaywallSession = ReturnType<typeof createPaywallSession>;
type PurchaseOutcome = Awaited<ReturnType<Parameters<typeof runComputePaywall>[0]["purchase"]>>;

const offering = { identifier: "compute" } as PurchasesOffering;
const selected = {
	identifier: "performance_annual",
	product: { identifier: "ai.clawdi.app.compute.performance.annual" },
} as PurchasesPackage;
const storeTransaction = { transactionIdentifier: "2000000001" } as PurchasesStoreTransaction;
const attempt = { attempt_id: "a1", state: "funding_applied" } as StorePurchaseAttempt;

function host() {
	const shown: { session?: PaywallSession; closed: number } = { closed: 0 };
	const present = (
		_offering: PurchasesOffering,
		signal: AbortSignal,
		options?: Parameters<typeof createPaywallSession>[3],
	) => {
		shown.session = createPaywallSession(signal, () => shown.closed++, 5, options);
		return shown.session;
	};
	const initiate = (resume = mock((_proceed: boolean) => undefined)) => {
		shown.session?.listeners.onPurchasePackageInitiated({
			packageBeingPurchased: selected,
			resume,
		});
		return resume;
	};
	return { shown, present, initiate };
}

describe("compute Paywall", () => {
	test("closing without choosing a package starts no purchase", async () => {
		const { shown, present } = host();
		const purchase = mock(async () => ({ status: "funding_applied", attempt }) as PurchaseOutcome);
		const result = runComputePaywall({
			offering,
			present,
			signal: new AbortController().signal,
			purchase,
		});
		shown.session?.listeners.onDismiss();
		expect(await result).toBeNull();
		expect(purchase).not.toHaveBeenCalled();
	});

	test("the Paywall buys the selected package only after the attempt exists", async () => {
		const { shown, present, initiate } = host();
		const resume = mock((_proceed: boolean) => undefined);
		const purchase = mock(
			async (pkg: PurchasesPackage, paywall: (signal: AbortSignal) => Promise<unknown>) => {
				expect(pkg).toBe(selected);
				expect(resume).not.toHaveBeenCalled();
				const transaction = paywall(new AbortController().signal);
				expect(resume.mock.calls).toEqual([[true]]);
				shown.session?.listeners.onPurchaseCompleted({ storeTransaction });
				shown.session?.listeners.onDismiss();
				expect(await transaction).toEqual({ transactionIdentifier: "2000000001" });
				return { status: "funding_applied", attempt } as PurchaseOutcome;
			},
		);
		const result = runComputePaywall({
			offering,
			present,
			signal: new AbortController().signal,
			purchase,
		});
		initiate(resume);
		expect(await result).toEqual({ status: "funding_applied", attempt });
		// A second selection in the same presentation is refused.
		expect(initiate()).toHaveBeenCalledWith(false);
	});

	test("a refused attempt releases the held purchase and closes the Paywall", async () => {
		const { shown, present, initiate } = host();
		const refused = new Error("store_slot_in_use");
		const result = runComputePaywall({
			offering,
			present,
			signal: new AbortController().signal,
			purchase: async () => {
				throw refused;
			},
		});
		const resume = initiate();
		await expect(result).rejects.toBe(refused);
		expect(resume).toHaveBeenCalledWith(false);
		expect(shown.closed).toBe(1);
	});

	test("a cancelled store sheet closes the Paywall with a null transaction", async () => {
		const { shown, present, initiate } = host();
		const result = runComputePaywall({
			offering,
			present,
			signal: new AbortController().signal,
			purchase: async (_pkg, paywall) => {
				const transaction = paywall(new AbortController().signal);
				shown.session?.listeners.onPurchaseCancelled();
				expect(await transaction).toBeNull();
				return { status: "cancelled", attempt } as PurchaseOutcome;
			},
		});
		initiate();
		expect((await result)?.status).toBe("cancelled");
		expect(shown.closed).toBe(1);
	});
});
