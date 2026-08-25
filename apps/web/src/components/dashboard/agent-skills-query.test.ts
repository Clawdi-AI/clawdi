import { describe, expect, test } from "bun:test";
import {
	environmentManager,
	focusManager,
	QueryClient,
	QueryObserver,
} from "@tanstack/react-query";
import {
	AGENT_PROJECT_SKILLS_REFRESH_POLICY,
	agentProjectSkillsQueryEnabled,
	agentProjectSkillsQueryKey,
	agentSkillForegroundRefetchInterval,
} from "./agent-skills-query";

describe("Agent Project Skills query lifecycle", () => {
	test("refreshes filesystem add, edit, and delete projections only in the foreground", async () => {
		environmentManager.setIsServer(() => false);
		focusManager.setFocused(true);
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const snapshots = [
			[{ skill_key: "alpha", version: 1 }],
			[
				{ skill_key: "alpha", version: 2 },
				{ skill_key: "beta", version: 1 },
			],
			[{ skill_key: "beta", version: 1 }],
		] as const;
		let calls = 0;
		const observer = new QueryObserver(queryClient, {
			queryKey: agentProjectSkillsQueryKey("agent-1", ["project-1"], "fence-1"),
			queryFn: async () => {
				const snapshot = snapshots[Math.min(calls, snapshots.length - 1)];
				calls += 1;
				return snapshot;
			},
			...AGENT_PROJECT_SKILLS_REFRESH_POLICY,
			refetchInterval: 5,
		});
		const unsubscribe = observer.subscribe(() => undefined);

		try {
			for (
				let attempt = 0;
				attempt < 30 && observer.getCurrentResult().data?.[0]?.skill_key !== "beta";
				attempt += 1
			) {
				await Bun.sleep(5);
			}
			expect(calls).toBeGreaterThanOrEqual(3);
			expect(observer.getCurrentResult().data).toEqual([{ skill_key: "beta", version: 1 }]);

			focusManager.setFocused(false);
			const callsWhileForeground = calls;
			await Bun.sleep(20);
			expect(calls).toBe(callsWhileForeground);
		} finally {
			unsubscribe();
			queryClient.clear();
			focusManager.setFocused(undefined);
			environmentManager.setIsServer(() => typeof window === "undefined");
		}
	});

	test("partitions cached rows by Agent, effective Project order, and projection fence", () => {
		const queryClient = new QueryClient();
		const currentKey = agentProjectSkillsQueryKey("agent-1", ["project-1", "project-2"], "fence-1");
		queryClient.setQueryData<Array<{ skill_key: string; version: number }>>(currentKey, [
			{ skill_key: "alpha", version: 1 },
		]);

		expect(
			queryClient.getQueryData<Array<{ skill_key: string; version: number }>>(currentKey),
		).toEqual([{ skill_key: "alpha", version: 1 }]);
		expect(
			queryClient.getQueryData(agentProjectSkillsQueryKey("agent-1", ["project-1"], "fence-1")),
		).toBeUndefined();
		expect(
			queryClient.getQueryData(
				agentProjectSkillsQueryKey("agent-1", ["project-2", "project-1"], "fence-1"),
			),
		).toBeUndefined();
		expect(
			queryClient.getQueryData(
				agentProjectSkillsQueryKey("agent-1", ["project-1", "project-2"], "fence-2"),
			),
		).toBeUndefined();
		expect(
			queryClient.getQueryData(
				agentProjectSkillsQueryKey("agent-2", ["project-1", "project-2"], "fence-1"),
			),
		).toBeUndefined();
		expect(agentProjectSkillsQueryEnabled(true, ["project-1"])).toBe(true);
		expect(agentProjectSkillsQueryEnabled(false, ["project-1"])).toBe(false);
		expect(agentProjectSkillsQueryEnabled(true, [])).toBe(false);
		expect(agentSkillForegroundRefetchInterval(true, true)).toBe(100_000);
	});
});
