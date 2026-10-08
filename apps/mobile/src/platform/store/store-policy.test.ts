import { describe, expect, mock, test } from "bun:test";

mock.module("react-native", () => ({ Platform: { OS: "ios" } }));
const { computePurchaseAvailable, storeRecoveryAction, storeSurfaces } = await import(
	"./store-policy"
);

describe("store build surfaces", () => {
	test("compute purchases require the store build, server flag, and an available slot", () => {
		const enabled = {
			compute_subscriptions_enabled: true,
			compute_slot: { available: true },
		};
		expect(computePurchaseAvailable({ environment: "production" }, enabled)).toBe(true);
		expect(computePurchaseAvailable({ environment: "preview" }, enabled)).toBe(false);
		expect(
			computePurchaseAvailable(
				{ environment: "production" },
				{ ...enabled, compute_subscriptions_enabled: false },
			),
		).toBe(false);
		expect(
			computePurchaseAvailable(
				{ environment: "production" },
				{
					...enabled,
					compute_slot: { available: false },
				},
			),
		).toBe(false);
		expect(
			computePurchaseAvailable(
				{ environment: "production" },
				{ ...enabled, compute_slot: { available: false } },
				{ target_contract_id: "11111111-1111-4111-8111-111111111111" },
			),
		).toBe(true);
	});

	test("store builds hide card-only surfaces and always show credits, even when unavailable", () => {
		for (const available of [true, false])
			expect(storeSurfaces(true, available)).toEqual({
				cardBilling: false,
				addCredits: true,
				creditUnits: true,
			});
	});

	test("preview/development builds keep Web parity", () => {
		expect(storeSurfaces(false, false)).toEqual({
			cardBilling: true,
			addCredits: false,
			creditUnits: false,
		});
		// Only a debug build with a usable store flow (Test Store) gets the Paywall entry.
		expect(storeSurfaces(false, true)).toEqual({
			cardBilling: true,
			addCredits: true,
			creditUnits: false,
		});
	});

	test("Wallet top_up opens the Paywall; card recovery is a neutral status on store builds", () => {
		const store = storeSurfaces(true, false);
		const preview = storeSurfaces(false, false);
		const invoice = { kind: "invoice", action: "fix_payment", url: "https://invoice" } as const;
		const fix = { kind: "fix_payment", action: "fix_payment" } as const;
		const topUp = { kind: "top_up", action: "top_up" } as const;
		const startNew = { kind: "start_new", action: "start_new" } as const;
		expect(storeRecoveryAction(store, topUp)).toBe("add_credits");
		expect(storeRecoveryAction(store, invoice)).toBe("card_status");
		expect(storeRecoveryAction(store, fix)).toBe("card_status");
		expect(storeRecoveryAction(store, startNew)).toBe("default");
		expect(storeRecoveryAction(store, null)).toBe("default");
		for (const target of [topUp, invoice, fix, startNew])
			expect(storeRecoveryAction(preview, target)).toBe("default");
	});
});
