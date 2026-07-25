import { describe, expect, test } from "bun:test";
import { createAppQueryClient } from "@/lib/query-client";
import { cacheValueContains } from "@/lib/sensitive-cache";
import { executeSensitiveAction } from "@/lib/use-sensitive-action";

function cachedState(queryClient: ReturnType<typeof createAppQueryClient>) {
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

describe("sensitive cache boundaries", () => {
	test("strips Stripe and credential fields before query data is cached", async () => {
		const queryClient = createAppQueryClient();
		const clientSecret = "pi_cache_test_secret_123";
		const providerToken = "provider-token-cache-test";

		await queryClient.prefetchQuery({
			queryKey: ["billing", "wallet"],
			queryFn: async () => ({
				balance_cents: 2_500,
				auto_reload_action: {
					attempt_id: 7,
					client_secret: clientSecret,
				},
			}),
		});
		queryClient.setQueryData(["credential-test"], {
			provider_token: providerToken,
			nested: { mem0_api_key: "mem0-cache-test", raw_key: "raw-cache-test", safe: "kept" },
		});

		const wallet = queryClient.getQueryData<Record<string, unknown>>(["billing", "wallet"]);
		expect(wallet?.balance_cents).toBe(2_500);
		expect(wallet?.auto_reload_action).toEqual({ attempt_id: 7 });
		expect(queryClient.getQueryData<Record<string, unknown>>(["credential-test"])).toEqual({
			nested: { safe: "kept" },
		});
		expect(cacheValueContains(cachedState(queryClient), clientSecret)).toBe(false);
		expect(cacheValueContains(cachedState(queryClient), providerToken)).toBe(false);
	});

	test("imperative secret actions leave MutationCache empty after settlement", async () => {
		const queryClient = createAppQueryClient();
		const apiKey = "sk-sensitive-action-test";
		const oneTimeToken = "one-time-sensitive-action-test";

		const result = await executeSensitiveAction(
			async (value: string) => ({ agent_token: oneTimeToken, accepted: value.length > 0 }),
			apiKey,
		);

		expect(result).toEqual({ agent_token: oneTimeToken, accepted: true });
		expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
		expect(cacheValueContains(cachedState(queryClient), apiKey)).toBe(false);
		expect(cacheValueContains(cachedState(queryClient), oneTimeToken)).toBe(false);
	});
});
