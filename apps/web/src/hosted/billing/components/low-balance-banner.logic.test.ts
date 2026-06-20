import { describe, expect, test } from "bun:test";
import type { WalletAutoReloadAction, WalletState } from "@/hosted/billing/contracts";
import { lowBalanceBannerState } from "./low-balance-banner.logic";

function wallet(over: Partial<WalletState> = {}): WalletState {
	return {
		balance_credits: 50_000,
		balance_snapshot_at: null,
		payment_mode: "card",
		auto_reload_enabled: false,
		auto_reload_threshold_credits: 1000,
		auto_reload_amount_cents: 2500,
		auto_reload_monthly_cap_cents: 0,
		auto_reload_action: null,
		points_per_usd: 1000,
		...over,
	};
}

function action(over: Partial<WalletAutoReloadAction> = {}): WalletAutoReloadAction {
	return {
		attempt_id: "att_1",
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
		// < $2 worth of credits trips the warning.
		const s = lowBalanceBannerState(wallet({ balance_credits: 1000 }));
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
