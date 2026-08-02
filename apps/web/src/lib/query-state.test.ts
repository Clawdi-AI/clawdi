import { describe, expect, test } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { shouldBlockQueryError } from "@/lib/query-state";

describe("query refresh presentation", () => {
	test("keeps successful data usable after a background refetch fails", async () => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		let attempt = 0;
		const observer = new QueryObserver(queryClient, {
			queryKey: ["refresh-contract"],
			queryFn: async () => {
				attempt += 1;
				if (attempt === 1) return { count: 3 };
				throw new Error("temporary refresh failure");
			},
		});
		const unsubscribe = observer.subscribe(() => undefined);

		try {
			await observer.refetch();
			await observer.refetch();
			const result = observer.getCurrentResult();

			expect(result.data).toEqual({ count: 3 });
			expect(result.error).toBeInstanceOf(Error);
			expect(shouldBlockQueryError(result.error, result.data)).toBe(false);
			expect(shouldBlockQueryError(result.error, undefined)).toBe(true);
		} finally {
			unsubscribe();
			queryClient.clear();
		}
	});
});
