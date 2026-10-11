import { resolveAgentWorkspaceProjectId } from "@clawdi/shared/api";
import { fetchAgentProjectSkills } from "@clawdi/shared/view";
import { useQuery } from "@tanstack/react-query";
import { useIsFocused } from "expo-router/react-navigation";
import { useCloudAgent } from "@/hooks/cloud-inventory";
import { skillsRefetchPolicy } from "@/hosted/agents/agent-desired-skills-query";
import { useMobileApi } from "@/lib/api-provider";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";

/**
 * The Agent workspace's agent-synced skills. Web's Skills tab lists them beside the managed
 * inventory, and both overviews count them.
 */
export function useAgentWorkspaceProjections(agentId: string, enabled = true) {
	const scope = useAccountScope();
	const read = useAccountRead();
	const api = useMobileApi();
	const focused = useIsFocused();
	const agent = useCloudAgent(agentId);
	const bindings = useQuery({
		queryKey: accountQueryKey(scope, "agent-overview-bindings", agentId),
		enabled: Boolean(enabled && agentId && scope.isReady),
		retry: false,
		queryFn: ({ signal }) => read((s) => api.agentProjects.listBindings(agentId, s), signal),
	});
	const workspace = agent.data
		? resolveAgentWorkspaceProjectId(bindings.data ?? [], agent.data.default_project_id)
		: null;
	const projections = useQuery({
		queryKey: accountQueryKey(scope, "agent-workspace-projections", workspace),
		enabled: Boolean(enabled && workspace && scope.isReady),
		retry: false,
		queryFn: ({ signal }) =>
			read(
				async (s) =>
					(
						await fetchAgentProjectSkills(
							workspace ? [workspace] : [],
							(project_id, page, page_size) =>
								api.cloud.listSkills({ project_id, page, page_size }, s),
						)
					).filter((skill) => skill.authority === "agent_sync"),
				signal,
			),
		...skillsRefetchPolicy(focused),
	});
	return {
		workspace,
		data: projections.data,
		error: agent.error ?? bindings.error ?? projections.error,
		refetch: () => {
			void agent.refetch();
			void bindings.refetch();
			if (workspace) void projections.refetch();
		},
	};
}
