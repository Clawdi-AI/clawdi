import { useQuery } from "@tanstack/react-query";
import { fetchAgentProjectSkills } from "@/components/dashboard/agent-skill-inventory";
import {
	AGENT_PROJECT_SKILLS_REFRESH_POLICY,
	agentProjectSkillsQueryKey,
} from "@/components/dashboard/agent-skills-query";
import { unwrap, useApi } from "@/lib/api";

export function useWorkspaceSkills(agentId: string, projectId: string | null, enabled = true) {
	const api = useApi();
	return useQuery({
		queryKey: agentProjectSkillsQueryKey(agentId, projectId ? [projectId] : [], "workspace"),
		queryFn: async () => {
			if (!projectId) throw new Error("Workspace is unavailable");
			const skills = await fetchAgentProjectSkills([projectId], async (id, page, pageSize) =>
				unwrap(
					await api.GET("/v1/skills", {
						params: { query: { project_id: id, page, page_size: pageSize } },
					}),
				),
			);
			return skills.filter((skill) => skill.authority === "agent_sync");
		},
		enabled: enabled && Boolean(projectId),
		...AGENT_PROJECT_SKILLS_REFRESH_POLICY,
	});
}
