"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { isProjectOwner } from "@/components/projects/project-metadata";
import { SkillCardGrid } from "@/components/skills/skill-card";
import { toastApiError, unwrap, useApi } from "@/lib/api";
import { fetchAllPages } from "@/lib/api-pagination";
import type { components } from "@/lib/api-schemas";

type SkillSummary = components["schemas"]["SkillSummaryResponse"];
type ProjectRow = components["schemas"]["ProjectResponse"];

export function useAgentProjectSkills(agentProjectId: string | null | undefined) {
	const api = useApi();

	// Fetch only this agent's Agent Project. The `project_id` query pushes the
	// filter into the database, then we walk every page so a large agent library
	// does not silently lose rows beyond the first page.
	const query = useQuery({
		queryKey: ["skills", agentProjectId, "all-pages"],
		queryFn: async () => {
			if (!agentProjectId) return { items: [], total: 0, page: 1, page_size: 200 };
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
		enabled: !!agentProjectId,
	});

	const skills = query.data?.items;
	return { ...query, skills };
}

export function AgentSkillsTab({
	agentId,
	agentProjectId,
	isResolvingAgentProject = false,
	writableProjectIds,
}: {
	agentId: string;
	agentProjectId: string | null | undefined;
	isResolvingAgentProject?: boolean;
	writableProjectIds?: ReadonlySet<string> | null;
}) {
	const api = useApi();
	const { data: projects } = useQuery({
		queryKey: ["projects"],
		queryFn: async (): Promise<ProjectRow[]> => unwrap(await api.GET("/v1/projects")),
		enabled: writableProjectIds === undefined && !!agentProjectId,
	});
	const derivedWritableProjectIds =
		writableProjectIds === undefined
			? new Set(
					(projects ?? [])
						.filter((project) => isProjectOwner(project))
						.map((project) => project.id),
				)
			: writableProjectIds;
	const {
		skills,
		isLoading: skillsLoading,
		error: skillsError,
		refetch: refetchSkills,
	} = useAgentProjectSkills(agentProjectId);
	const uninstallSkill = useUninstallAgentSkill();

	if (skillsError) {
		return (
			<ApiErrorPanel
				error={skillsError}
				onRetry={() => {
					void refetchSkills();
				}}
				title="Couldn't load agent skills"
			/>
		);
	}

	return (
		<SkillCardGrid
			skills={skills ?? []}
			isLoading={isResolvingAgentProject || skillsLoading}
			emptyMessage="No skills installed on this agent yet."
			readOnlySkillCheck={(s) =>
				!s.project_id || !(derivedWritableProjectIds?.has(s.project_id) ?? false)
			}
			onUninstall={(skillKey, projectId) => uninstallSkill.mutate({ skillKey, projectId })}
			uninstallPending={uninstallSkill.isPending}
			skillLink={(skill) => ({
				to: "/agents/$id/skills/$" as const,
				params: { id: agentId, _splat: skill.skill_key },
				search: skill.project_id ? { project: skill.project_id } : undefined,
			})}
		/>
	);
}

function useUninstallAgentSkill() {
	const api = useApi();
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: async ({ skillKey, projectId }: { skillKey: string; projectId: string }) =>
			unwrap(
				await api.DELETE("/v1/projects/{project_id}/skills/{skill_key}", {
					params: { path: { project_id: projectId, skill_key: skillKey } },
				}),
			),
		onSuccess: (_data, vars) => {
			toast.success("Skill uninstalled", {
				description: `${vars.skillKey} was removed from this agent. Other agents keep their copies.`,
			});
			queryClient.invalidateQueries({ queryKey: ["skills"] });
		},
		onError: toastApiError("Couldn't uninstall skill"),
	});
}
