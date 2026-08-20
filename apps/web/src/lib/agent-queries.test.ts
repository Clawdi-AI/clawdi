import { describe, expect, test } from "bun:test";
import type { components } from "@clawdi/shared/api";
import { QueryClient } from "@tanstack/react-query";
import { agentDetailQueryKey, syncAgentDetailCacheFromList } from "@/lib/agent-queries";

type Agent = components["schemas"]["AgentResponse"];

function agent(id: string, displayName: string): Agent {
	return {
		id,
		name: displayName,
		machine_name: `${id}.local`,
		display_name: displayName,
		sort_order: 0,
		agent_type: "codex",
		agent_version: "1.0.0",
		os: "linux",
		last_seen_at: null,
		queue_depth_high_water: 0,
		dropped_count: 0,
		sync_enabled: true,
		explicit_identity: true,
		default_project_id: `project-${id}`,
	};
}

describe("agent query cache", () => {
	test("projects list results into detail keys without replacing newer detail data", () => {
		const queryClient = new QueryClient();
		const listed = agent("agent-a", "Listed Agent");
		const detailKey = agentDetailQueryKey(listed.id);

		syncAgentDetailCacheFromList(queryClient, [listed], 100);
		expect(queryClient.getQueryData<Agent>(detailKey)).toEqual(listed);
		expect(queryClient.getQueryState(detailKey)?.dataUpdatedAt).toBe(100);
		syncAgentDetailCacheFromList(queryClient, [listed], 150);
		expect(queryClient.getQueryState(detailKey)?.dataUpdatedAt).toBe(150);

		const newerDetail = { ...listed, display_name: "Newer Detail" };
		queryClient.setQueryData(detailKey, newerDetail, { updatedAt: 200 });
		syncAgentDetailCacheFromList(queryClient, [{ ...listed, display_name: "Stale List" }], 175);

		expect(queryClient.getQueryData<Agent>(detailKey)).toEqual(newerDetail);
		expect(queryClient.getQueryState(detailKey)?.dataUpdatedAt).toBe(200);
	});
});
