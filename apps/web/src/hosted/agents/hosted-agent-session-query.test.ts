import { describe, expect, test } from "bun:test";
import {
	environmentManager,
	focusManager,
	QueryClient,
	QueryObserver,
} from "@tanstack/react-query";
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
