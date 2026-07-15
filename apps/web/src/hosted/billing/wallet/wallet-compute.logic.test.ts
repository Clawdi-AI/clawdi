import { describe, expect, test } from "bun:test";
import type { HostedDeployment, WalletState } from "@/hosted/billing/contracts";
import { decimalCredits, walletComputeCoverage } from "./wallet-compute.logic";

const wallet: WalletState = {
	balance_credits: 2_800,
	balance_snapshot_at: null,
	payment_mode: "card",
	x402_enabled: false,
	auto_reload_enabled: false,
	auto_reload_threshold_credits: 0,
	auto_reload_amount_cents: 0,
	auto_reload_monthly_cap_cents: 0,
	auto_reload_action: null,
	points_per_usd: 100,
};

function deployment(
	id: string,
	plan: "compute_basic" | "compute_performance",
	priceCents: number,
	renewal: string,
): HostedDeployment {
	return {
		id,
		user_id: "usr_test",
		name: id,
		app_id: id,
		status: "running",
		created_at: "2026-07-01T00:00:00Z",
		upgrade_available: false,
		config_info: {
			compute_plan_slug: plan,
			mux_enabled: false,
			telegram_mux_enabled: false,
			discord_mux_enabled: false,
			whatsapp_mux_enabled: false,
			imessage_mux_enabled: false,
			kobb_available: false,
			ai_provider_auth_kind: "managed",
			runtime: "hermes",
		},
		compute_subscription: {
			status: "active",
			funding_source: "wallet",
			payment_state: "ok",
			billing_term_months: 1,
			price_cents: priceCents,
			currency: "usd",
			cancel_at_period_end: false,
			current_period_end: renewal,
		},
	};
}

describe("walletComputeCoverage", () => {
	test("sums wallet deployments, orders renewals, and warns below one month", () => {
		const result = walletComputeCoverage(wallet, [
			deployment("later", "compute_performance", 1_900, "2026-08-20T00:00:00Z"),
			deployment("sooner", "compute_basic", 900, "2026-08-15T00:00:00Z"),
		]);
		expect(result.totalMonthlyCents).toBe(2_800);
		expect(result.balanceValueCents).toBe(2_800);
		expect(result.coverageMonths).toBe(1);
		expect(result.lowCoverage).toBe(false);
		expect(result.deployments.map((item) => item.deploymentId)).toEqual(["sooner", "later"]);

		const actualLow = walletComputeCoverage({ ...wallet, balance_credits: 2_799 }, [
			deployment("basic", "compute_basic", 900, "2026-08-15T00:00:00Z"),
			deployment("perf", "compute_performance", 1_900, "2026-08-20T00:00:00Z"),
		]);
		expect(actualLow.lowCoverage).toBe(true);
	});

	test("ignores Stripe-funded deployments", () => {
		const stripe = deployment("stripe", "compute_basic", 900, "2026-08-15T00:00:00Z");
		if (stripe.compute_subscription) stripe.compute_subscription.funding_source = "stripe";
		expect(walletComputeCoverage(wallet, [stripe]).deployments).toEqual([]);
	});
});

describe("decimalCredits", () => {
	test("parses decimal strings and rejects non-finite values", () => {
		expect(decimalCredits("19000.5000")).toBe(19_000.5);
		expect(decimalCredits("not-a-number")).toBe(0);
	});
});
