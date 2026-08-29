"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { toast } from "sonner";
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
import { displayProjectName } from "@/components/projects/project-metadata";
import { SkillCardGrid } from "@/components/skills/skill-card";
import { agentSkillDetailLink } from "@/lib/agent-routes";
import { unwrap, useApi, useOpenApi } from "@/lib/api";
import { normalizeApiError } from "@/lib/api-errors";
import { identityFor } from "@/lib/identity";
import { shouldBlockQueryError } from "@/lib/query-state";
import { skillCapabilities } from "@/lib/skill-authority";

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
	const bindingsResolved = bindings.data !== undefined;
	const queryEnabled =
		enabled && agentProjectSkillsQueryEnabled(bindingsResolved, scope.projectIds) && !scope.error;

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
	const blockingBindingsError = shouldBlockQueryError(bindings.error, bindings.data)
		? bindings.error
		: null;
	const error = blockingBindingsError ?? scope.error ?? query.error;
	const isLoading =
		enabled &&
		(bindings.isLoading ||
			(bindingsResolved && !scope.error && scope.projectIds.length > 0 && query.isLoading));
	const refetch = async () => {
		if (!bindings.data || blockingBindingsError || scope.error) {
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
	isResolvingAgentProject = false,
	projectionFence = agentId,
}: {
	agentId: string;
	agentProjectId: string | null | undefined;
	isResolvingAgentProject?: boolean;
	projectionFence?: string;
}) {
	const api = useApi();
	const $api = useOpenApi();
	const queryClient = useQueryClient();
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
	const projects = $api.useQuery(
		"get",
		"/v1/projects",
		{},
		{
			enabled: !isResolvingAgentProject,
		},
	);
	const projectsById = useMemo(
		() => new Map((projects.data ?? []).map((project) => [project.id, project])),
		[projects.data],
	);
	const removeSkill = useMutation({
		mutationFn: async ({ skillKey, projectId }: { skillKey: string; projectId: string }) =>
			unwrap(
				await api.DELETE("/v1/projects/{project_id}/skills/{skill_key}", {
					params: { path: { project_id: projectId, skill_key: skillKey } },
				}),
			),
		onSuccess: async () => {
			await Promise.all([
				refetchSkills(),
				queryClient.invalidateQueries({ queryKey: ["get", "/v1/projects"] }),
			]);
			toast.success("Skill removed from Project");
		},
		onError: (error) =>
			toast.error("Couldn't remove Skill from Project", {
				description: normalizeApiError(error),
			}),
	});

	if (shouldBlockQueryError(skillsError, skills)) {
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
			{shouldBlockQueryError(projects.error, projects.data) ? (
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
				onUninstall={(skillKey, projectId) => removeSkill.mutateAsync({ skillKey, projectId })}
				uninstallPending={removeSkill.isPending}
				sourceLabelFor={(skill) => {
					const project = skill.project_id ? projectsById.get(skill.project_id) : undefined;
					const name = project ? displayProjectName(project) : skill.project_name?.trim();
					return name ? { name, emoji: identityFor(name).emoji } : null;
				}}
				skillLink={(skill) => agentSkillDetailLink(agentId, skill.skill_key, skill.project_id)}
			/>
		</div>
	);
}
