import { describe, expect, test } from "bun:test";
import type { QueryClient } from "@tanstack/react-query";
import { createAppQueryClient } from "@/lib/query-client";
import { cacheValueContains, sanitizeQueryCacheValue } from "@/lib/sensitive-cache";

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

	test("matches mixed-case fields through arrays and deeply nested JSON payloads", () => {
		const secrets = {
			client: "mixed-case-client-secret",
			credential: "array-object-credential",
			deep: "deeply-nested-token",
		};
		let deeplyNested: unknown = { ToKeN: secrets.deep, safe: "deep value" };
		for (let depth = 0; depth < 128; depth += 1) {
			deeplyNested = depth % 2 === 0 ? [{ child: deeplyNested }] : { child: deeplyNested };
		}
		const payload = {
			CLIENT_SECRET: secrets.client,
			items: [{ CrEdEnTiAlS: secrets.credential, safe: "array value" }],
			deeplyNested,
		};

		const sanitized = sanitizeQueryCacheValue(payload);
		for (const secret of Object.values(secrets)) {
			expect(cacheValueContains(sanitized, secret)).toBe(false);
		}
		expect(cacheValueContains(sanitized, "array value")).toBe(true);
		expect(cacheValueContains(sanitized, "deep value")).toBe(true);
	});
});
