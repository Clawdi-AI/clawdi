import { describe, expect, test } from "bun:test";
import {
	environmentManager,
	focusManager,
	QueryClient,
	QueryObserver,
} from "@tanstack/react-query";
import { shouldBlockQueryError } from "@/lib/query-state";
import {
	canQueryHostedAgentSessions,
	HOSTED_AGENT_SESSIONS_REFETCH_INTERVAL_MS,
	HOSTED_AGENT_SESSIONS_REFRESH_POLICY,
} from "./hosted-agent-session-query";

describe("hosted agent sessions refresh", () => {
	test("uses the stable environment identity as the only backend query prerequisite", () => {
		expect(canQueryHostedAgentSessions("4f4f8630-5a38-4d31-89ad-2e5451f6ba8f")).toBe(true);
		expect(canQueryHostedAgentSessions("hdep_starting")).toBe(false);
		expect(canQueryHostedAgentSessions("")).toBe(false);
	});

	test("preserves successful data and stays non-blocking after a refetch error", async () => {
		const error = new Error("background refresh failed");
		const cachedData = { items: [{ id: "session-1" }], total: 1 };
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		let calls = 0;
		const observer = new QueryObserver(queryClient, {
			queryKey: ["test", "hosted-sessions-refetch-error"],
			queryFn: async () => {
				calls += 1;
				if (calls === 1) return cachedData;
				throw error;
			},
		});
		let resolveFirstSuccess = (_result: ReturnType<typeof observer.getCurrentResult>) => {};
		const firstSuccess = new Promise<ReturnType<typeof observer.getCurrentResult>>((resolve) => {
			resolveFirstSuccess = resolve;
		});
		const unsubscribe = observer.subscribe((result) => {
			if (result.isSuccess && !result.isFetching) resolveFirstSuccess(result);
		});

		try {
			const first = await firstSuccess;
			expect(first.data).toEqual(cachedData);
			expect(first.isSuccess).toBe(true);

			const second = await observer.refetch();
			expect(calls).toBe(2);
			expect(second.data).toEqual(cachedData);
			expect(second.error).toBe(error);
			expect(second.isRefetchError).toBe(true);
			expect(shouldBlockQueryError(second.error, second.data)).toBe(false);
			expect(shouldBlockQueryError(error, undefined)).toBe(true);
		} finally {
			unsubscribe();
			queryClient.clear();
		}
	});

	test("polls only while an observer is mounted in the foreground", async () => {
		expect(HOSTED_AGENT_SESSIONS_REFETCH_INTERVAL_MS).toBe(30_000);
		expect(HOSTED_AGENT_SESSIONS_REFRESH_POLICY).toEqual({
			refetchInterval: 30_000,
			refetchIntervalInBackground: false,
		});
		environmentManager.setIsServer(() => false);
		focusManager.setFocused(false);
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		let calls = 0;
		const observer = new QueryObserver(queryClient, {
			queryKey: ["test", "hosted-sessions-foreground-refresh"],
			queryFn: async () => {
				calls += 1;
				return { items: [], total: 0 };
			},
			...HOSTED_AGENT_SESSIONS_REFRESH_POLICY,
			refetchInterval: 5,
		});
		const unsubscribe = observer.subscribe(() => undefined);
		let mounted = true;

		try {
			await Bun.sleep(20);
			expect(calls).toBe(1);

			focusManager.setFocused(true);
			for (let attempt = 0; attempt < 20 && calls === 1; attempt += 1) {
				await Bun.sleep(5);
			}
			expect(calls).toBeGreaterThan(1);

			unsubscribe();
			mounted = false;
			const callsAfterUnmount = calls;
			await Bun.sleep(20);
			expect(calls).toBe(callsAfterUnmount);
		} finally {
			if (mounted) unsubscribe();
			queryClient.clear();
			focusManager.setFocused(undefined);
			environmentManager.setIsServer(() => typeof window === "undefined");
		}
	});
});
