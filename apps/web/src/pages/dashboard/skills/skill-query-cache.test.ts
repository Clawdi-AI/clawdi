import { describe, expect, test } from "bun:test";
import {
	environmentManager,
	focusManager,
	QueryClient,
	QueryObserver,
} from "@tanstack/react-query";
import {
	AGENT_PROJECT_SKILLS_REFRESH_POLICY,
	agentSkillForegroundRefetchInterval,
} from "@/components/dashboard/agent-skills-query";
import { ApiError, isApiNotFoundError } from "@/lib/api-errors";
import {
	removeDeletedSkillQueries,
	skillDetailQueryKey,
	skillDetailQueryPrefix,
	skillDetailViewState,
} from "@/pages/dashboard/skills/skill-query-cache";

describe("removeDeletedSkillQueries", () => {
	test("removes deleted skill detail queries by prefix and invalidates skill lists", async () => {
		const qc = new QueryClient();
		const skillKey = "review/code";

		qc.setQueryData(skillDetailQueryKey(skillKey, "project_a"), { key: skillKey });
		qc.setQueryData(skillDetailQueryKey(skillKey, "project_b"), { key: skillKey });
		qc.setQueryData(skillDetailQueryKey("other/skill", "project_a"), { key: "other/skill" });
		qc.setQueryData(["skills"], [{ key: skillKey }]);
		qc.setQueryData(["skills", "all-projects"], [{ key: skillKey }]);

		await removeDeletedSkillQueries(qc, skillKey);

		expect(qc.getQueryData(skillDetailQueryKey(skillKey, "project_a"))).toBeUndefined();
		expect(qc.getQueryData(skillDetailQueryKey(skillKey, "project_b"))).toBeUndefined();
		expect(qc.getQueryData(skillDetailQueryPrefix(skillKey))).toBeUndefined();
		expect(
			qc.getQueryData<{ key: string }>(skillDetailQueryKey("other/skill", "project_a")),
		).toEqual({
			key: "other/skill",
		});
		expect(qc.getQueryState(["skills"])?.isInvalidated).toBe(true);
		expect(qc.getQueryState(["skills", "all-projects"])?.isInvalidated).toBe(true);
	});

	test("partitions Agent detail from Cloud-owned detail cache", () => {
		const qc = new QueryClient();
		qc.setQueryData(skillDetailQueryKey("review/code", "project-a", "agent:agent-a"), {
			content: "agent projection",
		});

		expect(qc.getQueryData(skillDetailQueryKey("review/code", "project-a"))).toBeUndefined();
		expect(
			qc.getQueryData(skillDetailQueryKey("review/code", "project-a", "agent:agent-b")),
		).toBeUndefined();
		expect(agentSkillForegroundRefetchInterval(true)).toBe(10_000);
		expect(agentSkillForegroundRefetchInterval(false)).toBe(false);
	});

	test("refreshes Agent detail edits and makes a later delete authoritative", async () => {
		environmentManager.setIsServer(() => false);
		focusManager.setFocused(true);
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const deleted = new ApiError(404, "projection deleted");
		let calls = 0;
		const seenContent: string[] = [];
		const observer = new QueryObserver(queryClient, {
			queryKey: skillDetailQueryKey("review/code", "project-a", "agent:agent-a"),
			queryFn: async () => {
				calls += 1;
				if (calls === 1) return { content: "version one" };
				if (calls === 2) return { content: "version two" };
				throw deleted;
			},
			...AGENT_PROJECT_SKILLS_REFRESH_POLICY,
			refetchInterval: (query) => (isApiNotFoundError(query.state.error) ? false : 5),
		});
		const unsubscribe = observer.subscribe((result) => {
			if (result.data?.content && !seenContent.includes(result.data.content)) {
				seenContent.push(result.data.content);
			}
		});

		try {
			for (
				let attempt = 0;
				attempt < 30 && observer.getCurrentResult().error !== deleted;
				attempt += 1
			) {
				await Bun.sleep(5);
			}
			expect(seenContent).toEqual(["version one", "version two"]);
			expect(observer.getCurrentResult().error).toBe(deleted);
			expect(observer.getCurrentResult().data).toEqual({ content: "version two" });
			expect(
				skillDetailViewState({
					skillKey: "review/code",
					error: observer.getCurrentResult().error,
					hasSkill: observer.getCurrentResult().data !== undefined,
					isLoading: observer.getCurrentResult().isLoading,
				}),
			).toBe("not-found");
		} finally {
			unsubscribe();
			queryClient.clear();
			focusManager.setFocused(undefined);
			environmentManager.setIsServer(() => typeof window === "undefined");
		}
	});
});
