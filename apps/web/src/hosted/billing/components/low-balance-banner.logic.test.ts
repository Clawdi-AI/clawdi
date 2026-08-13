import { describe, expect, test } from "bun:test";
import type { WalletAutoReloadAction, WalletState } from "@/hosted/billing/contracts";
import { lowBalanceBannerState } from "./low-balance-banner.logic";

function wallet(over: Partial<WalletState> = {}): WalletState {
	return {
		balance_usd: "50",
		x402_enabled: true,
		auto_reload_enabled: false,
		auto_reload_has_payment_method: false,
		auto_reload_card: null,
		auto_reload_currency: "usd",
		auto_reload_required_consent_version: "wallet_auto_reload_off_session_v2",
		auto_reload_amount_policy: "wallet_reload_configured_plus_negative_balance_v1",
		auto_reload_consent_version: null,
		auto_reload_consented_at: null,
		auto_reload_threshold_usd: "1",
		auto_reload_amount_cents: 2500,
		auto_reload_monthly_cap_cents: 0,
		auto_reload_monthly_spent_cents: 0,
		auto_reload_period_end: "2026-09-01T00:00:00Z",
		auto_reload_status: "off",
		auto_reload_action: null,
		...over,
	};
}

function action(over: Partial<WalletAutoReloadAction> = {}): WalletAutoReloadAction {
	return {
		attempt_id: 1,
		payment_intent_id: "pi_1",
		client_secret: "pi_1_secret",
		error_code: null,
		...over,
	};
}

describe("lowBalanceBannerState", () => {
	test("undefined wallet → hidden", () => {
		expect(lowBalanceBannerState(undefined).show).toBe(false);
	});

	test("healthy balance, no action → hidden", () => {
		const s = lowBalanceBannerState(wallet());
		expect(s.show).toBe(false);
		expect(s.primaryCta).toBe("none");
	});

	test("low balance, no action → top-up CTA", () => {
		const s = lowBalanceBannerState(wallet({ balance_usd: "1" }));
		expect(s).toMatchObject({ show: true, low: true, hasAction: false, primaryCta: "top-up" });
	});

	test("SCA pending (no error_code) → confirm CTA even with a healthy balance", () => {
		const s = lowBalanceBannerState(wallet({ auto_reload_action: action() }));
		expect(s).toMatchObject({
			show: true,
			hasAction: true,
			declined: false,
			needsAction: true,
			primaryCta: "confirm",
		});
	});

	test("declined auto-reload → retry CTA", () => {
		const s = lowBalanceBannerState(
			wallet({ auto_reload_action: action({ error_code: "card_declined" }) }),
		);
		expect(s).toMatchObject({
			show: true,
			hasAction: true,
			declined: true,
			needsAction: false,
			primaryCta: "retry",
		});
	});
});
