import { describe, expect, test } from "bun:test";
import type { WalletState } from "@/hosted/billing/contracts";
import { BillingApiError } from "@/hosted/billing/errors";
import {
	autoReloadDraftFromWallet,
	autoReloadDraftIsDirty,
	autoReloadFormState,
	autoReloadRequest,
	autoReloadSaveError,
} from "./auto-reload-card.logic";

const validForm = {
	amount: "25",
	threshold: "1",
	cap: "100",
};

describe("autoReloadFormState", () => {
	test("rejects a blank monthly cap instead of converting it to no cap", () => {
		const state = autoReloadFormState({ ...validForm, cap: "" });

		expect(Number.isNaN(state.capCents)).toBe(true);
		expect(state.capValid).toBe(false);
		expect(state.formValid).toBe(false);
	});

	test("keeps an explicit 0 monthly cap as the no-cap value", () => {
		const state = autoReloadFormState({ ...validForm, cap: "0" });

		expect(state.capCents).toBe(0);
		expect(state.capValid).toBe(true);
		expect(state.formValid).toBe(true);
	});

	test("preserves the direct $1 threshold floor", () => {
		expect(autoReloadFormState({ ...validForm, threshold: "0.99" }).thresholdValid).toBe(false);
		expect(autoReloadFormState({ ...validForm, threshold: "1" }).thresholdValid).toBe(true);
	});

	test("rejects values with more than two decimal places instead of rounding them", () => {
		expect(autoReloadFormState({ ...validForm, amount: "25.001" }).amountValid).toBe(false);
		expect(autoReloadFormState({ ...validForm, threshold: "1.001" }).thresholdValid).toBe(false);
		expect(autoReloadFormState({ ...validForm, cap: "100.001" }).capValid).toBe(false);
	});
});

const wallet: WalletState = {
	balance_usd: "25",
	payment_mode: "card",
	x402_enabled: false,
	auto_reload_enabled: false,
	auto_reload_threshold_usd: "5",
	auto_reload_amount_cents: 2_500,
	auto_reload_monthly_cap_cents: 10_000,
	auto_reload_action: null,
};

describe("auto-reload explicit-save state", () => {
	test("builds one atomic request containing the toggle and every parameter", () => {
		const draft = {
			...autoReloadDraftFromWallet(wallet),
			enabled: true,
			threshold: "7.50",
			amount: "30",
			cap: "125",
		};

		expect(autoReloadRequest(draft)).toEqual({
			auto_reload_enabled: true,
			auto_reload_threshold_usd: 7.5,
			auto_reload_amount_cents: 3_000,
			auto_reload_monthly_cap_cents: 12_500,
		});
	});

	test("includes all parameters when disabling auto-reload", () => {
		const draft = autoReloadDraftFromWallet({ ...wallet, auto_reload_enabled: true });

		expect(autoReloadRequest({ ...draft, enabled: false })).toEqual({
			auto_reload_enabled: false,
			auto_reload_threshold_usd: 5,
			auto_reload_amount_cents: 2_500,
			auto_reload_monthly_cap_cents: 10_000,
		});
	});

	test("tracks semantic changes without treating equivalent dollar formatting as dirty", () => {
		const baseline = autoReloadDraftFromWallet(wallet);

		expect(autoReloadDraftIsDirty({ ...baseline, amount: "25.00" }, baseline)).toBe(false);
		expect(autoReloadDraftIsDirty({ ...baseline, amount: "26" }, baseline)).toBe(true);
		expect(autoReloadDraftIsDirty({ ...baseline, amount: "" }, baseline)).toBe(true);
	});
});

describe("autoReloadSaveError", () => {
	test("maps payment-method and field failures to actionable copy", () => {
		expect(
			autoReloadSaveError(
				new BillingApiError(400, "Auto reload requires a default payment method"),
			),
		).toMatchObject({ requiresPaymentMethod: true, field: null });
		expect(
			autoReloadSaveError(
				new BillingApiError(400, "Auto reload amount must be between 500 and 50000 cents"),
			),
		).toMatchObject({ field: "amount", requiresPaymentMethod: false });
	});

	test("keeps unknown structured codes out of user-facing copy", () => {
		const copy = autoReloadSaveError(
			new BillingApiError(409, "internal", {
				detail: { code: "wallet_reload_bridge_internal_17" },
			}),
		);

		expect(copy.description).not.toContain("wallet_reload_bridge_internal_17");
		expect(copy.description).toMatch(/refresh and try again/i);
	});
});
