import { describe, expect, test } from "bun:test";
import type { components } from "@clawdi/shared/api";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import {
	agentDetailInitialDataOptions,
	agentDetailQueryKey,
	agentsQueryKey,
} from "@/lib/agent-queries";

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
	test("initializes an empty detail from the list without replacing detail data", () => {
		const queryClient = new QueryClient();
		const listed = agent("agent-a", "Listed Agent");
		const detailKey = agentDetailQueryKey(listed.id);
		queryClient.setQueryData(agentsQueryKey, [listed], { updatedAt: 100 });

		const observer = new QueryObserver(queryClient, {
			queryKey: detailKey,
			queryFn: async () => listed,
			staleTime: Number.POSITIVE_INFINITY,
			...agentDetailInitialDataOptions(queryClient, listed.id),
		});
		expect(observer.getCurrentResult().data).toEqual(listed);
		expect(queryClient.getQueryState(detailKey)?.dataUpdatedAt).toBe(100);

		const newerDetail = { ...listed, display_name: "Newer Detail" };
		queryClient.setQueryData(detailKey, newerDetail, { updatedAt: 200 });
		observer.setOptions({
			queryKey: detailKey,
			queryFn: async () => listed,
			staleTime: Number.POSITIVE_INFINITY,
			...agentDetailInitialDataOptions(queryClient, listed.id),
		});

		expect(observer.getCurrentResult().data).toEqual(newerDetail);
		expect(queryClient.getQueryState(detailKey)?.dataUpdatedAt).toBe(200);

		const directObserver = new QueryObserver(queryClient, {
			queryKey: agentDetailQueryKey("agent-b"),
			queryFn: async () => agent("agent-b", "Direct Agent"),
			...agentDetailInitialDataOptions(queryClient, "agent-b"),
		});
		expect(directObserver.getCurrentResult().status).toBe("pending");
	});
});
