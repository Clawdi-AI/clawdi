import { describe, expect, test } from "bun:test";
import type { WalletState } from "@/hosted/billing/contracts";
import { BillingApiError } from "@/hosted/billing/errors";
import {
	autoReloadDraftFromWallet,
	autoReloadDraftIsDirty,
	autoReloadFormState,
	autoReloadRequest,
	autoReloadSaveError,
	autoReloadStatusSummary,
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

	test("requires a finite limit to cover one reload and supports an explicit no-limit choice", () => {
		const tooSmall = autoReloadFormState({ ...validForm, cap: "20" });
		const unlimited = autoReloadFormState({ ...validForm, cap: "", unlimited: true });

		expect(tooSmall.capValid).toBe(false);
		expect(unlimited.capCents).toBe(0);
		expect(unlimited.capValid).toBe(true);
		expect(unlimited.formValid).toBe(true);
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
	x402_enabled: false,
	auto_reload_enabled: false,
	auto_reload_threshold_usd: "5",
	auto_reload_amount_cents: 2_500,
	auto_reload_monthly_cap_cents: 10_000,
	auto_reload_monthly_spent_cents: 2_500,
	auto_reload_period_end: "2026-09-01T00:00:00Z",
	auto_reload_status: "off",
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

describe("autoReloadStatusSummary", () => {
	test("explains a monthly-limit pause without implying auto-reload was turned off", () => {
		expect(
			autoReloadStatusSummary({
				...wallet,
				auto_reload_enabled: true,
				auto_reload_status: "paused_monthly_limit",
			}),
		).toEqual({
			label: "Paused",
			tone: "warning",
			description: "Monthly limit reached. Auto-reload resumes Sep 1.",
		});
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
