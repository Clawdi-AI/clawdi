"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { useAgentProjectBindings } from "@/components/dashboard/agent-project-bindings-query";
import { resolveAgentProjectScope } from "@/components/dashboard/agent-project-scope";
import { fetchAgentProjectSkills } from "@/components/dashboard/agent-skill-inventory";
import {
	AGENT_PROJECT_SKILLS_REFRESH_POLICY,
	agentProjectSkillsQueryEnabled,
	agentProjectSkillsQueryKey,
	agentSkillForegroundRefetchInterval,
} from "@/components/dashboard/agent-skills-query";
import { SkillCardGrid } from "@/components/skills/skill-card";
import { type AgentRouteSearch, agentSkillDetailLink } from "@/lib/agent-routes";
import { unwrap, useApi } from "@/lib/api";
import type { components } from "@/lib/api-schemas";
import { identityFor } from "@/lib/identity";
import { skillCapabilities } from "@/lib/skill-authority";

type ProjectRow = components["schemas"]["ProjectResponse"];

export function useAgentProjectSkills(
	agentId: string,
	agentProjectId: string | null | undefined,
	projectionFence: string,
	foregroundRefresh = true,
	enabled = true,
) {
	const api = useApi();
	const bindings = useAgentProjectBindings(agentId, { enabled });
	const scope = useMemo<{ projectIds: string[]; error: unknown | null }>(() => {
		if (!bindings.data) return { projectIds: [], error: null };
		try {
			return {
				projectIds: resolveAgentProjectScope(bindings.data, agentProjectId).projectIds,
				error: null,
			};
		} catch (error) {
			return { projectIds: [], error };
		}
	}, [agentProjectId, bindings.data]);
	const queryEnabled =
		enabled && agentProjectSkillsQueryEnabled(bindings.isSuccess, scope.projectIds) && !scope.error;

	// Bindings are resolved before any Skill request. Each effective Project is
	// server-filtered and fully paginated, then rows remain in Project read order.
	const query = useQuery({
		queryKey: agentProjectSkillsQueryKey(agentId, scope.projectIds, projectionFence),
		queryFn: async () => {
			return fetchAgentProjectSkills(
				scope.projectIds,
				async (projectId, page, pageSize) =>
					unwrap(
						await api.GET("/v1/skills", {
							params: {
								query: {
									page,
									page_size: pageSize,
									project_id: projectId,
								},
							},
						}),
					),
				{ pageSize: 200 },
			);
		},
		enabled: queryEnabled,
		...AGENT_PROJECT_SKILLS_REFRESH_POLICY,
		refetchInterval: agentSkillForegroundRefetchInterval(foregroundRefresh && queryEnabled),
	});

	const skills = query.data;
	const error = bindings.error ?? scope.error ?? query.error;
	const isLoading =
		enabled &&
		(bindings.isLoading ||
			(bindings.isSuccess && !scope.error && scope.projectIds.length > 0 && query.isLoading));
	const refetch = async () => {
		if (!bindings.data || bindings.error || scope.error) {
			await bindings.refetch();
			return;
		}
		await query.refetch();
	};
	return { ...query, skills, error, isLoading, refetch, projectIds: scope.projectIds };
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
	const api = useApi();
	const {
		skills,
		isLoading: skillsLoading,
		error: skillsError,
		refetch: refetchSkills,
	} = useAgentProjectSkills(
		agentId,
		agentProjectId,
		projectionFence,
		true,
		!isResolvingAgentProject,
	);
	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: async (): Promise<ProjectRow[]> => unwrap(await api.GET("/v1/projects")),
		enabled: !isResolvingAgentProject,
	});
	const projectsById = useMemo(
		() => new Map((projects.data ?? []).map((project) => [project.id, project])),
		[projects.data],
	);

	if (skillsError) {
		return (
			<div>
				<ApiErrorPanel
					error={skillsError}
					onRetry={() => {
						void refetchSkills();
					}}
					title="Couldn't load agent Skills"
				/>
			</div>
		);
	}

	return (
		<div className="space-y-4" data-testid="agent-skills-inventory">
			{projects.error ? (
				<ApiErrorPanel
					error={projects.error}
					onRetry={() => {
						void projects.refetch();
					}}
					title="Couldn't load Project labels"
				/>
			) : null}
			<SkillCardGrid
				skills={skills ?? []}
				isLoading={isResolvingAgentProject || skillsLoading}
				emptyMessage="No Skills yet."
				capabilitiesFor={(skill) =>
					skillCapabilities(
						skill,
						skill.project_id ? projectsById.get(skill.project_id) : undefined,
					)
				}
				sourceLabelFor={(skill) => {
					const project = skill.project_id ? projectsById.get(skill.project_id) : undefined;
					const name = project?.name ?? skill.project_name ?? skill.project_id;
					return name ? { name, emoji: identityFor(name).emoji } : null;
				}}
				skillLink={(skill) =>
					agentSkillDetailLink(agentId, skill.skill_key, skill.project_id, routeSearch)
				}
			/>
		</div>
	);
}
