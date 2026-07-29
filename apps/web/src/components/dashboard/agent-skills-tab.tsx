"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { isProjectOwner } from "@/components/projects/project-metadata";
import { SkillCardGrid } from "@/components/skills/skill-card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
	const runtimeObserved = useQuery({
		queryKey: ["runtime-observed", agentId],
		queryFn: async () =>
			unwrap(
				await api.GET("/v1/agents/{agent_id}/runtime-observed", {
					params: { path: { agent_id: agentId } },
				}),
			),
		enabled: hostedManaged,
	});
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
	const managedResources = runtimeObserved.data?.desired?.managed_resources ?? [];
	const managedSkills = managedResources.filter((resource) => resource.kind === "skill");
	const managedMcpServers = managedResources.filter((resource) => resource.kind === "mcp_server");
	const reservedSkillIds = new Set(
		managedSkills.filter((skill) => skill.enabled).map((skill) => skill.id),
	);
	const conflictingSkills = (skills ?? []).filter((skill) => reservedSkillIds.has(skill.skill_key));
	const desiredGeneration = runtimeObserved.data?.desired?.desired_config_generation ?? null;
	const observedGeneration = runtimeObserved.data?.observed?.observed_config_generation ?? null;
	const desiredSource = runtimeObserved.data?.desired?.desired_source_revision ?? null;
	const observedSource = runtimeObserved.data?.observed?.observed_source_revision ?? null;
	const isApplied =
		runtimeObserved.data?.health.status === "ok" &&
		desiredGeneration !== null &&
		desiredGeneration === observedGeneration &&
		(desiredSource === null || desiredSource === observedSource);

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
				<p className="text-sm text-muted-foreground">Loading deployment-managed capabilities…</p>
			) : null}
			{hostedManaged && runtimeObserved.error ? (
				<Alert>
					<AlertTitle>Managed capability status is unavailable</AlertTitle>
					<AlertDescription>Your Cloud Skills remain available below.</AlertDescription>
				</Alert>
			) : null}
			{runtimeObserved.data ? (
				<section className="rounded-xl border p-4" aria-label="Deployment-managed capabilities">
					<div className="flex flex-wrap items-center justify-between gap-2">
						<h2 className="font-medium">Deployment-managed capabilities</h2>
						<Badge variant={isApplied ? "secondary" : "outline"}>
							{isApplied ? "Applied" : "Not applied"}
						</Badge>
					</div>
					<p className="mt-1 text-sm text-muted-foreground">
						Desired generation {runtimeObserved.data.desired?.desired_config_generation ?? "—"} ·
						Observed generation {runtimeObserved.data.observed?.observed_config_generation ?? "—"}
					</p>
					<p className="mt-1 text-xs text-muted-foreground">
						Health {runtimeObserved.data.health.status} · Source{" "}
						{(observedSource ?? desiredSource ?? "Not reported").slice(0, 12)}
						{runtimeObserved.data.observed?.observed_manifest_etag ? " · Manifest observed" : ""}
					</p>
					<div className="mt-4 grid gap-4 md:grid-cols-2">
						<div>
							<h3 className="text-sm font-medium">Skills</h3>
							<div className="mt-2 flex flex-wrap gap-2">
								{managedSkills.map((skill) => (
									<Badge key={skill.id} variant="secondary">
										{skill.id} · v{skill.version} · {skill.enabled ? "enabled" : "disabled"}
									</Badge>
								))}
								{managedSkills.length === 0 ? (
									<span className="text-sm text-muted-foreground">None</span>
								) : null}
							</div>
						</div>
						<div>
							<h3 className="text-sm font-medium">MCP servers</h3>
							<div className="mt-2 flex flex-wrap gap-2">
								{managedMcpServers.map((server) => (
									<Badge key={server.id} variant="secondary">
										{server.id}
									</Badge>
								))}
								{managedMcpServers.length === 0 ? (
									<span className="text-sm text-muted-foreground">None</span>
								) : null}
							</div>
						</div>
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
