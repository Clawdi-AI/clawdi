"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { isProjectOwner } from "@/components/projects/project-metadata";
import { SkillCardGrid } from "@/components/skills/skill-card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { useAgentRuntimeObserved } from "@/hooks/use-agent-runtime-observed";
import { type AgentRouteSearch, agentSkillDetailLink } from "@/lib/agent-routes";
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
	routeSearch,
	isResolvingAgentProject = false,
	writableProjectIds,
	hostedManaged = false,
}: {
	agentId: string;
	agentProjectId: string | null | undefined;
	routeSearch: AgentRouteSearch;
	isResolvingAgentProject?: boolean;
	writableProjectIds?: ReadonlySet<string> | null;
	hostedManaged?: boolean;
}) {
	const api = useApi();
	const runtimeObserved = useAgentRuntimeObserved(agentId, hostedManaged);
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
	const managedSkills = runtimeObserved.data?.desired?.managed_skills ?? [];
	const reservedSkillIds = new Set(managedSkills.map((skill) => skill.id));
	const conflictingSkills = (skills ?? []).filter((skill) => reservedSkillIds.has(skill.skill_key));

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
		<div className="flex flex-col gap-6">
			{hostedManaged && runtimeObserved.isLoading ? (
				<p className="text-sm text-muted-foreground">Loading deployment-managed Skills…</p>
			) : null}
			{hostedManaged && runtimeObserved.error ? (
				<Alert>
					<AlertTitle>Deployment-managed Skills are unavailable</AlertTitle>
					<AlertDescription>Your Cloud Skills remain available below.</AlertDescription>
				</Alert>
			) : null}
			{managedSkills.length > 0 ? (
				<section className="rounded-xl border p-4" aria-label="Deployment-managed Skills">
					<h2 className="font-medium">Deployment-managed Skills</h2>
					<p className="mt-1 text-sm text-muted-foreground">
						These Skills are read-only and follow the deployment manifest.
					</p>
					<div className="mt-3 flex flex-wrap gap-2">
						{managedSkills.map((skill) => (
							<Badge key={skill.id} variant="secondary">
								{skill.id} · v{skill.version}
							</Badge>
						))}
					</div>
				</section>
			) : null}
			{conflictingSkills.length > 0 ? (
				<Alert>
					<AlertTitle>Cloud Skill conflicts with deployment-managed Skill</AlertTitle>
					<AlertDescription>
						You can uninstall the Cloud copy below; the managed copy is read-only.
					</AlertDescription>
				</Alert>
			) : null}
			<SkillCardGrid
				skills={skills ?? []}
				isLoading={isResolvingAgentProject || skillsLoading}
				emptyMessage="No skills installed on this agent yet."
				readOnlySkillCheck={(s) =>
					!s.project_id || !(derivedWritableProjectIds?.has(s.project_id) ?? false)
				}
				cleanupOnlySkillCheck={(skill) => reservedSkillIds.has(skill.skill_key)}
				onUninstall={(skillKey, projectId) => uninstallSkill.mutate({ skillKey, projectId })}
				uninstallPending={uninstallSkill.isPending}
				skillLink={(skill) =>
					agentSkillDetailLink(agentId, skill.skill_key, skill.project_id, routeSearch)
				}
			/>
		</div>
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
