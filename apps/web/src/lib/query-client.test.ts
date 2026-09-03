import { describe, expect, test } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { resetQueryClientForAuthChange } from "@/lib/query-client";

describe("query cache authentication boundary", () => {
	test("refetches active observers while removing prior-user cached state", async () => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		let attempt = 0;
		const observer = new QueryObserver(queryClient, {
			queryKey: ["auth-change", "active"],
			queryFn: () => {
				attempt += 1;
				if (attempt === 1) return new Promise<string>(() => undefined);
				return Promise.resolve("fresh-user-data");
			},
		});
		const unsubscribe = observer.subscribe(() => undefined);
		queryClient.setQueryData(["auth-change", "inactive"], "prior-user-data");
		queryClient.getMutationCache().build(queryClient, {
			mutationKey: ["auth-change", "mutation"],
			mutationFn: async () => "prior-user-result",
		});

		try {
			expect(observer.getCurrentResult().fetchStatus).toBe("fetching");
			expect(queryClient.getMutationCache().getAll()).toHaveLength(1);

			await resetQueryClientForAuthChange(queryClient);

			expect(queryClient.getQueryData(["auth-change", "inactive"])).toBeUndefined();
			expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
			expect(attempt).toBe(2);
			expect(observer.getCurrentResult()).toMatchObject({
				data: "fresh-user-data",
				fetchStatus: "idle",
				status: "success",
			});
		} finally {
			unsubscribe();
			queryClient.clear();
		}
	});
});
