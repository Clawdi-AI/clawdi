"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { Link2, Plus, Unlink } from "lucide-react";
import { parseAsString, useQueryState } from "nuqs";
import { type ReactNode, useRef } from "react";
import { toast } from "sonner";
import { ApiErrorPanel } from "@/components/api-error-panel";
import {
	agentProjectBindingsQueryKey,
	useAgentProjectBindings,
} from "@/components/dashboard/agent-project-bindings-query";
import { EmptyState } from "@/components/empty-state";
import { HERO_GRID_CLASS } from "@/components/entity-card";
import { ListToolbar } from "@/components/list-toolbar";
import { PageHeader } from "@/components/page-header";
import { CreateProjectDialog } from "@/components/projects/create-project-dialog";
import { ProjectActions } from "@/components/projects/project-actions";
import {
	canManageCustomProject,
	compareProjectsForUse,
	isCustomProject,
	projectMatchesSearch,
	projectSearchRank,
} from "@/components/projects/project-metadata";
import {
	ProjectResourceCard,
	ProjectResourceCardSkeleton,
	UnavailableProjectResourceCard,
} from "@/components/projects/project-resource-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/ui/search-input";
import { Spinner } from "@/components/ui/spinner";
import { agentDetailQueryKey } from "@/lib/agent-queries";
import { unwrap, useApi, useOpenApi } from "@/lib/api";
import { normalizeApiError } from "@/lib/api-errors";
import {
	formatResourceCount,
	getProjectResourceDefinition,
	projectDetailHref,
} from "@/lib/project-resource-model";
import { shouldBlockQueryError } from "@/lib/query-state";
import {
	agentResourceScope,
	LIBRARY_RESOURCE_SCOPE,
	resourceCollectionTarget,
} from "@/lib/resource-navigation";

/** The same readable Project catalog in Library and Agent context. */
export function ProjectsSurface({
	agentId,
	enabled = true,
	headerIcon,
	headerAdornment,
}: {
	agentId?: string;
	enabled?: boolean;
	headerIcon?: ReactNode;
	headerAdornment?: ReactNode;
}) {
	const api = useApi();
	const $api = useOpenApi();
	const queryClient = useQueryClient();
	const router = useRouter();
	const [search, setSearch] = useQueryState(
		"q",
		parseAsString.withDefault("").withOptions({ clearOnDefault: true, history: "replace" }),
	);
	const projects = $api.useQuery("get", "/v1/projects", {}, { enabled });
	const bindings = useAgentProjectBindings(agentId, { enabled });
	const linkLocked = useRef(false);
	const scope = agentId ? agentResourceScope(agentId) : LIBRARY_RESOURCE_SCOPE;
	const primary = bindings.data?.filter((binding) => binding.binding_type === "primary");
	const linksKnown = bindings.data !== undefined && !bindings.error && primary?.length === 1;
	const linkedIds = new Set(
		bindings.data
			?.filter((binding) => binding.binding_type === "context")
			.map((binding) => binding.project_id),
	);
	const rows = (projects.data ?? [])
		.filter(isCustomProject)
		.filter((project) => projectMatchesSearch(project, search))
		.sort(
			(a, b) =>
				(projectSearchRank(a, search) ?? 0) - (projectSearchRank(b, search) ?? 0) ||
				compareProjectsForUse(a, b),
		);
	const missingBindings =
		!search.trim() && linksKnown && projects.data && !projects.error
			? (bindings.data ?? []).filter(
					(binding) =>
						binding.binding_type === "context" &&
						!projects.data?.some((project) => project.id === binding.project_id),
				)
			: [];
	const refresh = async () => {
		await Promise.all([
			queryClient.invalidateQueries({ queryKey: ["get", "/v1/projects"] }),
			queryClient.invalidateQueries({ queryKey: ["get", "/v1/projects/{project_id}"] }),
			queryClient.invalidateQueries({ queryKey: ["get", "/v1/agents"] }),
			queryClient.invalidateQueries({ queryKey: ["get", "/v1/vault"] }),
			queryClient.invalidateQueries({ queryKey: ["skills"] }),
			queryClient.invalidateQueries({ queryKey: ["vaults"] }),
			...(agentId
				? [
						queryClient.invalidateQueries({ queryKey: agentProjectBindingsQueryKey(agentId) }),
						queryClient.invalidateQueries({ queryKey: agentDetailQueryKey(agentId) }),
					]
				: []),
		]);
	};
	const updateLink = useMutation({
		mutationFn: async ({ projectId, linked }: { projectId: string; linked: boolean }) => {
			if (!agentId || !linksKnown) throw new Error("Refresh Project links and try again.");
			return unwrap(
				await api.PATCH("/v1/agents/{agent_id}/projects", {
					params: { path: { agent_id: agentId } },
					body: {
						add_project_ids: linked ? [] : [projectId],
						remove_project_ids: linked ? [projectId] : [],
					},
				}),
			);
		},
		onSuccess: async (_, { linked }) => {
			await refresh();
			toast.success(linked ? "Project unlinked" : "Project linked");
		},
		onError: (error) =>
			toast.error("Couldn't update Project link", { description: normalizeApiError(error) }),
		onSettled: () => {
			linkLocked.current = false;
		},
	});
	const actionsDisabled =
		projects.isLoading ||
		Boolean(projects.error) ||
		updateLink.isPending ||
		Boolean(agentId && !linksKnown);
	const returnHref = resourceCollectionTarget(scope, "projects").href;
	const from = `${returnHref}${search ? `?q=${encodeURIComponent(search)}` : ""}`;

	return (
		<div className="space-y-6" data-testid={agentId ? "agent-project-stack" : "projects-surface"}>
			<PageHeader
				title="Projects"
				icon={headerIcon}
				titleAdornment={headerAdornment}
				description={
					agentId
						? "Your Projects and Projects shared with you. Link a Project to use its Skills and attached Vaults together."
						: getProjectResourceDefinition("projects").managementDescription
				}
				actions={
					<CreateProjectDialog
						agentId={agentId}
						onCreated={async (project) => {
							await refresh();
							toast.success(agentId ? "Project created and linked" : "Project created", {
								description: agentId
									? "This Agent can use its Skills and attached Vaults immediately."
									: "It is ready for Skills, Vaults, and Agent links.",
								action: {
									label: "Open project",
									onClick: () =>
										void router.navigate({
											href: `${projectDetailHref(project.id)}${agentId ? `?from=${encodeURIComponent(from)}` : ""}`,
										}),
								},
							});
						}}
					>
						<Button size="sm" disabled={actionsDisabled}>
							<Plus className="size-3.5" />
							Create project
						</Button>
					</CreateProjectDialog>
				}
			/>
			<ListToolbar
				search={<SearchInput value={search} onChange={setSearch} placeholder="Search projects…" />}
			/>
			{agentId && bindings.error ? (
				<ApiErrorPanel
					error={bindings.error}
					onRetry={() => void bindings.refetch()}
					title="Couldn't load Project links"
				/>
			) : null}
			{agentId && bindings.data && !bindings.error && !linksKnown ? (
				<EmptyState
					variant="inset"
					description="This Agent's Workspace is not available yet. You can browse Projects while linking is unavailable."
				/>
			) : null}
			{projects.error ? (
				<ApiErrorPanel
					error={projects.error}
					onRetry={() => void projects.refetch()}
					title="Couldn't load Projects"
				/>
			) : null}
			{projects.isLoading ? (
				<div className={HERO_GRID_CLASS}>
					{Array.from({ length: 3 }).map((_, index) => (
						<ProjectResourceCardSkeleton key={index} />
					))}
				</div>
			) : shouldBlockQueryError(projects.error, projects.data) ? null : rows.length === 0 &&
				missingBindings.length === 0 ? (
				<EmptyState
					title={search.trim() ? "No matching Projects" : "No Projects yet"}
					description={
						search.trim()
							? `Nothing matches “${search.trim()}”. Try a different search.`
							: "Create a Project to bundle Skills and Vaults for your Agents."
					}
				/>
			) : (
				<ul
					className={HERO_GRID_CLASS}
					aria-label="Projects"
					data-testid={agentId ? "agent-project-grid" : "project-grid"}
				>
					{rows.map((project) => {
						const linked = linksKnown && linkedIds.has(project.id);
						const pending = updateLink.isPending && updateLink.variables.projectId === project.id;
						return (
							<li
								key={project.id}
								className="min-w-0"
								data-testid={agentId ? "agent-project-card" : "project-card"}
							>
								<ProjectResourceCard
									className="h-full"
									project={project}
									searchQuery={search.trim() || undefined}
									navigationScope={linked ? scope : LIBRARY_RESOURCE_SCOPE}
									link={
										agentId && !linked
											? { to: "/projects/$id", params: { id: project.id }, search: { from } }
											: undefined
									}
									status={
										agentId && linksKnown ? (
											<Badge variant={linked ? "secondary" : "outline"}>
												{linked ? "Linked" : "Not linked"}
											</Badge>
										) : undefined
									}
									footer={[
										formatResourceCount(project.skill_count, "skill"),
										formatResourceCount(project.vault_count, "vault"),
										project.is_owner === false && (project.owner_display || project.owner_handle)
											? `by ${project.owner_display || project.owner_handle}`
											: null,
									]}
									primaryAction={
										agentId ? (
											<Button
												size="sm"
												variant={linked ? "outline" : "default"}
												disabled={actionsDisabled}
												aria-label={
													linksKnown
														? `${linked ? "Unlink" : "Link"} ${project.name}`
														: `Link status unavailable for ${project.name}`
												}
												onClick={() => {
													if (actionsDisabled || linkLocked.current) return;
													linkLocked.current = true;
													updateLink.mutate({ projectId: project.id, linked });
												}}
											>
												{pending ? (
													<Spinner className="size-3.5" />
												) : linked ? (
													<Unlink className="size-3.5" />
												) : (
													<Link2 className="size-3.5" />
												)}
												{linksKnown
													? linked
														? "Unlink"
														: "Link"
													: bindings.isLoading
														? "Loading…"
														: "Link unavailable"}
											</Button>
										) : undefined
									}
									actions={
										canManageCustomProject(project) ? (
											<ProjectActions project={project} onChanged={refresh} />
										) : undefined
									}
								/>
							</li>
						);
					})}
					{missingBindings.map((binding) => (
						<li key={binding.id}>
							<UnavailableProjectResourceCard />
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
