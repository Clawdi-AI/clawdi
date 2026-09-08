import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { memorySettingsForCache } from "@/components/memories/memory-settings-cache";
import type { WalletState } from "@/hosted/billing/contracts";
import { walletSnapshotForCache } from "@/hosted/billing/wallet/wallet-cache";
import { cacheValueContains } from "@/lib/sensitive-cache";

function cachedState(queryClient: QueryClient) {
	return {
		queries: queryClient
			.getQueryCache()
			.getAll()
			.map((query) => ({ queryKey: query.queryKey, state: query.state })),
		mutations: queryClient
			.getMutationCache()
			.getAll()
			.map((mutation) => mutation.state),
	};
}

function createUnsanitizedQueryClient(): QueryClient {
	// Deliberately bypass createAppQueryClient and its sensitive-cache guard.
	return new QueryClient({
		defaultOptions: {
			queries: { retry: false, structuralSharing: false },
		},
	});
}

describe("structural secret boundaries without the denylist", () => {
	test("fixed query flows stay secret-free in a raw QueryClient", async () => {
		const queryClient = createUnsanitizedQueryClient();
		const secrets = {
			stripe: "pi_raw-query-client-secret",
			walletFuture: "future-wallet-secret-with-an-unregistered-name",
			mem0: "mem0-raw-query-api-key",
			settingsFuture: "future-settings-secret-with-an-unregistered-name",
		};
		const wallet: WalletState = {
			balance_usd: "25.00",
			x402_enabled: true,
			x402_payment_authority: null,
			x402_payment_status: "idle",
			auto_reload_enabled: true,
			auto_reload_has_payment_method: true,
			auto_reload_card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 },
			auto_reload_currency: "usd",
			auto_reload_required_consent_version: "wallet_auto_reload_off_session_v2",
			auto_reload_amount_policy: "wallet_reload_configured_plus_negative_balance_v1",
			auto_reload_consent_version: "wallet_auto_reload_off_session_v2",
			auto_reload_consented_at: "2026-08-01T00:00:00Z",
			auto_reload_threshold_usd: "5",
			auto_reload_amount_cents: 2_500,
			auto_reload_monthly_cap_cents: 10_000,
			auto_reload_monthly_spent_cents: 2_500,
			auto_reload_period_end: "2026-09-01T00:00:00Z",
			auto_reload_status: "active",
			auto_reload_action: {
				attempt_id: 7,
				payment_intent_id: "pi_structural_test",
				client_secret: secrets.stripe,
				error_code: null,
			},
		};
		const walletWithFutureSecret = {
			...wallet,
			future_material: { value: secrets.walletFuture },
		};
		await Promise.all([
			queryClient.prefetchQuery({
				queryKey: ["billing", "wallet"],
				queryFn: async () => walletSnapshotForCache(walletWithFutureSecret),
			}),
			queryClient.prefetchQuery({
				queryKey: ["settings"],
				queryFn: async () =>
					memorySettingsForCache({
						memory_provider: "mem0",
						mem0_api_key: secrets.mem0,
						future_material: secrets.settingsFuture,
					}),
			}),
		]);

		expect(queryClient.getQueryData(["billing", "wallet"])).toMatchObject({
			balance_usd: "25.00",
			auto_reload_action: {
				attempt_id: 7,
				payment_intent_id: "pi_structural_test",
			},
		});
		expect(
			queryClient.getQueryData<ReturnType<typeof memorySettingsForCache>>(["settings"]),
		).toEqual({
			memory_provider: "mem0",
			mem0_api_key_configured: true,
		});
		for (const secret of Object.values(secrets)) {
			expect(cacheValueContains(cachedState(queryClient), secret)).toBe(false);
		}
		expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
	});
});
