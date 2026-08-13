import { beforeAll, describe, expect, test } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type { WalletState } from "@/hosted/billing/contracts";
import { billingKeys } from "@/hosted/billing/query-keys";
import type { WalletCacheSnapshot } from "@/hosted/billing/wallet/wallet-cache";

type WalletSnapshotQueryOptions =
	typeof import("@/hosted/billing/wallet/wallet-query").walletSnapshotQueryOptions;

let walletSnapshotQueryOptions: WalletSnapshotQueryOptions | null = null;
let refreshIntervalMs = 0;

beforeAll(async () => {
	process.env.VITE_CLAWDI_API_URL = "http://localhost:8000";
	process.env.VITE_CLAWDI_DEPLOY_API_URL = "http://localhost:50021";
	process.env.VITE_CLERK_PUBLISHABLE_KEY = "pk_test_dummy";
	const module = await import("@/hosted/billing/wallet/wallet-query");
	walletSnapshotQueryOptions = module.walletSnapshotQueryOptions;
	refreshIntervalMs = module.WALLET_SNAPSHOT_REFRESH_INTERVAL_MS;
});

describe("walletSnapshotQueryOptions", () => {
	test("shares the canonical cache key and does not refetch for a second fresh observer", async () => {
		if (!walletSnapshotQueryOptions) throw new Error("Wallet query options were not loaded");
		let calls = 0;
		const wallet: WalletState = {
			balance_usd: "25.00",
			x402_enabled: false,
			auto_reload_enabled: false,
			auto_reload_has_payment_method: true,
			auto_reload_card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 },
			auto_reload_currency: "usd",
			auto_reload_required_consent_version: "wallet_auto_reload_off_session_v2",
			auto_reload_amount_policy: "wallet_reload_configured_plus_negative_balance_v1",
			auto_reload_consent_version: "wallet_auto_reload_off_session_v2",
			auto_reload_consented_at: "2026-08-01T00:00:00Z",
			auto_reload_threshold_usd: "5.00",
			auto_reload_amount_cents: 2_500,
			auto_reload_monthly_cap_cents: 10_000,
			auto_reload_monthly_spent_cents: 2_500,
			auto_reload_period_end: "2026-09-01T00:00:00Z",
			auto_reload_status: "active",
			auto_reload_action: {
				attempt_id: 7,
				payment_intent_id: "pi_test",
				client_secret: "must-not-enter-cache",
				error_code: null,
			},
		};
		const options = walletSnapshotQueryOptions({
			getWallet: async () => {
				calls += 1;
				return wallet;
			},
		});
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

		await queryClient.fetchQuery(options);
		const first = new QueryObserver(queryClient, options);
		const second = new QueryObserver(queryClient, options);
		const unsubscribeFirst = first.subscribe(() => undefined);
		const unsubscribeSecond = second.subscribe(() => undefined);
		await Promise.resolve();

		expect(options.queryKey).toBe(billingKeys.wallet);
		expect(options.staleTime).toBe(refreshIntervalMs);
		expect(options.refetchInterval).toBe(refreshIntervalMs);
		expect(calls).toBe(1);
		expect(queryClient.getQueryData<WalletCacheSnapshot>(billingKeys.wallet)).toEqual({
			balance_usd: "25.00",
			x402_enabled: false,
			auto_reload_enabled: false,
			auto_reload_has_payment_method: true,
			auto_reload_card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 },
			auto_reload_currency: "usd",
			auto_reload_required_consent_version: "wallet_auto_reload_off_session_v2",
			auto_reload_amount_policy: "wallet_reload_configured_plus_negative_balance_v1",
			auto_reload_consent_version: "wallet_auto_reload_off_session_v2",
			auto_reload_consented_at: "2026-08-01T00:00:00Z",
			auto_reload_threshold_usd: "5.00",
			auto_reload_amount_cents: 2_500,
			auto_reload_monthly_cap_cents: 10_000,
			auto_reload_monthly_spent_cents: 2_500,
			auto_reload_period_end: "2026-09-01T00:00:00Z",
			auto_reload_status: "active",
			auto_reload_action: {
				attempt_id: 7,
				payment_intent_id: "pi_test",
				error_code: null,
			},
		});

		unsubscribeFirst();
		unsubscribeSecond();
		queryClient.clear();
	});
});
