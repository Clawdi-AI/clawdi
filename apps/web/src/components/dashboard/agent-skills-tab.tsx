"use client";

import { useQuery } from "@tanstack/react-query";
import { ApiErrorPanel } from "@/components/api-error-panel";
import {
	AGENT_PROJECT_SKILLS_REFRESH_POLICY,
	agentProjectSkillsQueryEnabled,
	agentProjectSkillsQueryKey,
	agentSkillForegroundRefetchInterval,
} from "@/components/dashboard/agent-skills-query";
import { SkillCardGrid } from "@/components/skills/skill-card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { type AgentRouteSearch, agentSkillDetailLink } from "@/lib/agent-routes";
import { unwrap, useApi } from "@/lib/api";
import { fetchAllPages } from "@/lib/api-pagination";
import type { components } from "@/lib/api-schemas";
import { skillCapabilities } from "@/lib/skill-authority";

type SkillSummary = components["schemas"]["SkillSummaryResponse"];

export function useAgentProjectSkills(
	agentId: string,
	agentProjectId: string | null | undefined,
	projectionFence: string,
	foregroundRefresh = true,
) {
	const api = useApi();
	const projectAvailable = agentProjectSkillsQueryEnabled(agentProjectId);

	// Fetch only this agent's Agent Project. The `project_id` query pushes the
	// filter into the database, then we walk every page so a large agent library
	// does not silently lose rows beyond the first page.
	const query = useQuery({
		queryKey: agentProjectSkillsQueryKey(agentId, agentProjectId, projectionFence),
		queryFn: async () => {
			if (!agentProjectId) throw new Error("Agent Project is unavailable");
			return fetchAllPages<SkillSummary>(
				async (page, pageSize) =>
					unwrap(
						await api.GET("/v1/skills", {
							params: {
								query: {
									page,
									page_size: pageSize,
									project_id: agentProjectId,
								},
							},
						}),
					),
				{ pageSize: 200, resourceName: "agent skills" },
			);
		},
		enabled: projectAvailable,
		...AGENT_PROJECT_SKILLS_REFRESH_POLICY,
		refetchInterval: agentSkillForegroundRefetchInterval(foregroundRefresh && projectAvailable),
	});

	const skills = query.data?.items;
	return { ...query, skills };
}

export function AgentSkillsTab({
	agentId,
	agentProjectId,
	routeSearch,
	isResolvingAgentProject = false,
	projectionFence = agentId,
}: {
	agentId: string;
	agentProjectId: string | null | undefined;
	routeSearch: AgentRouteSearch;
	isResolvingAgentProject?: boolean;
	projectionFence?: string;
}) {
	const {
		skills,
		isLoading: skillsLoading,
		error: skillsError,
		refetch: refetchSkills,
	} = useAgentProjectSkills(agentId, agentProjectId, projectionFence);
	if (!agentProjectId && !isResolvingAgentProject) {
		return (
			<div>
				<Alert>
					<AlertTitle>Agent-synced Skills are unavailable</AlertTitle>
					<AlertDescription>
						The Agent Project is not available. No empty filesystem inventory is being inferred.
					</AlertDescription>
				</Alert>
			</div>
		);
	}

	if (skillsError) {
		return (
			<div>
				<ApiErrorPanel
					error={skillsError}
					onRetry={() => {
						void refetchSkills();
					}}
					title="Couldn't load agent-synced skills"
				/>
			</div>
		);
	}

	return (
		<div>
			<SkillCardGrid
				skills={skills ?? []}
				isLoading={isResolvingAgentProject || skillsLoading}
				emptyMessage="No skills installed on this agent yet."
				capabilitiesFor={(skill) =>
					skillCapabilities(skill, { kind: "environment", is_owner: true })
				}
				skillLink={(skill) =>
					agentSkillDetailLink(agentId, skill.skill_key, skill.project_id, routeSearch)
				}
			/>
		</div>
	);
}
