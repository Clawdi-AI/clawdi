"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { Link2, Plus, Save } from "lucide-react";
import { type ReactNode, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ApiErrorPanel } from "@/components/api-error-panel";
import {
	agentProjectBindingsQueryKey,
	useAgentProjectBindings,
} from "@/components/dashboard/agent-project-bindings-query";
import {
	type AgentProjectBinding,
	orderedAgentProjectBindings,
} from "@/components/dashboard/agent-project-scope";
import { EmptyState } from "@/components/empty-state";
import { HERO_GRID_CLASS } from "@/components/entity-card";
import { PageHeader } from "@/components/page-header";
import { CreateProjectDialog } from "@/components/projects/create-project-dialog";
import { ProjectActions } from "@/components/projects/project-actions";
import {
	compareProjectsForUse,
	displayProjectName,
	isCustomProject,
	ProjectIdentity,
} from "@/components/projects/project-metadata";
import {
	ProjectResourceCard,
	ProjectResourceCardSkeleton,
	UnavailableProjectResourceCard,
} from "@/components/projects/project-resource-card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { agentDetailQueryKey } from "@/lib/agent-queries";
import { unwrap, useApi, useOpenApi } from "@/lib/api";
import { normalizeApiError } from "@/lib/api-errors";
import type { components } from "@/lib/api-schemas";
import { formatResourceCount, projectDetailHref } from "@/lib/project-resource-model";
import { shouldBlockQueryError } from "@/lib/query-state";
import {
	agentResourceScope,
	type ResourceNavigationScope,
	resourceCollectionTarget,
} from "@/lib/resource-navigation";

type ProjectRow = components["schemas"]["ProjectResponse"];

export function AgentProjectsTab({
	agentId,
	enabled = true,
	headerIcon,
	headerAdornment,
}: {
	agentId: string;
	enabled?: boolean;
	headerIcon?: ReactNode;
	headerAdornment?: ReactNode;
}) {
	const $api = useOpenApi();
	const queryClient = useQueryClient();
	const projects = $api.useQuery(
		"get",
		"/v1/projects",
		{},
		{
			enabled,
		},
	);
	const bindings = useAgentProjectBindings(agentId, { enabled });
	const refresh = async () => {
		await Promise.all([
			queryClient.invalidateQueries({ queryKey: agentProjectBindingsQueryKey(agentId) }),
			queryClient.invalidateQueries({ queryKey: ["get", "/v1/projects"] }),
			queryClient.invalidateQueries({ queryKey: ["get", "/v1/projects/{project_id}"] }),
			queryClient.invalidateQueries({ queryKey: ["get", "/v1/agents"] }),
			queryClient.invalidateQueries({
				queryKey: agentDetailQueryKey(agentId),
			}),
			queryClient.invalidateQueries({ queryKey: ["get", "/v1/vault"] }),
			queryClient.invalidateQueries({ queryKey: ["skills"] }),
			queryClient.invalidateQueries({ queryKey: ["vaults"] }),
		]);
	};

	const navigationScope = agentResourceScope(agentId);
	return (
		<AgentProjectsPanel
			agentId={agentId}
			bindings={bindings.data ?? []}
			projects={projects.data ?? []}
			isLoading={bindings.isLoading || projects.isLoading}
			bindingsError={shouldBlockQueryError(bindings.error, bindings.data) ? bindings.error : null}
			onRetryBindings={() => {
				void bindings.refetch();
			}}
			projectsError={shouldBlockQueryError(projects.error, projects.data) ? projects.error : null}
			onRetryProjects={() => {
				void projects.refetch();
			}}
			navigationScope={navigationScope}
			headerIcon={headerIcon}
			headerAdornment={headerAdornment}
			onChanged={refresh}
		/>
	);
}

function AgentProjectsPanel({
	agentId,
	bindings,
	projects,
	isLoading,
	bindingsError,
	onRetryBindings,
	projectsError,
	onRetryProjects,
	navigationScope,
	headerIcon,
	headerAdornment,
	onChanged,
}: {
	agentId: string;
	bindings: AgentProjectBinding[];
	projects: ProjectRow[];
	isLoading: boolean;
	bindingsError?: unknown;
	onRetryBindings?: () => void;
	projectsError?: unknown;
	onRetryProjects?: () => void;
	navigationScope: ResourceNavigationScope;
	headerIcon?: ReactNode;
	headerAdornment?: ReactNode;
	onChanged: () => Promise<void>;
}) {
	const api = useApi();
	const router = useRouter();
	const [managedProjectIds, setManagedProjectIds] = useState<Set<string>>(() => new Set());
	const [manageOpen, setManageOpen] = useState(false);
	// React Query pending state is post-render. These refs reject a second
	// submit synchronously, before another mutation can queue in the same frame.
	const manageProjectsLockedRef = useRef(false);
	const orderedBindings = orderedAgentProjectBindings(bindings);
	const primary = orderedBindings.find((binding) => binding.binding_type === "primary") ?? null;
	const contexts = orderedBindings.filter((binding) => binding.binding_type === "context");
	const projectsById = useMemo(
		() => new Map(projects.map((project) => [project.id, project])),
		[projects],
	);
	const manageableProjects = useMemo(
		() => projects.filter(isCustomProject).sort(compareProjectsForUse),
		[projects],
	);
	const linkedProjectIds = useMemo(
		() => new Set(bindings.map((binding) => binding.project_id)),
		[bindings],
	);
	const projectIdsToAdd = manageableProjects
		.filter((project) => managedProjectIds.has(project.id) && !linkedProjectIds.has(project.id))
		.map((project) => project.id);
	const projectIdsToRemove = manageableProjects
		.filter((project) => linkedProjectIds.has(project.id) && !managedProjectIds.has(project.id))
		.map((project) => project.id);
	const hasProjectChanges = projectIdsToAdd.length > 0 || projectIdsToRemove.length > 0;

	const updateProjectLinks = useMutation({
		mutationFn: async ({
			addProjectIds,
			removeProjectIds,
		}: {
			addProjectIds: string[];
			removeProjectIds: string[];
		}) => {
			return unwrap(
				await api.PATCH("/v1/agents/{agent_id}/projects", {
					params: { path: { agent_id: agentId } },
					body: {
						add_project_ids: addProjectIds,
						remove_project_ids: removeProjectIds,
					},
				}),
			);
		},
		onSuccess: async () => {
			await onChanged();
			setManageOpen(false);
			toast.success("Project access updated");
		},
		onError: (error) =>
			toast.error("Couldn't update Project access", {
				description: normalizeApiError(error),
			}),
		onSettled: () => {
			manageProjectsLockedRef.current = false;
		},
	});

	const submitProjectChanges = () => {
		if (!hasProjectChanges || manageProjectsLockedRef.current) return;
		manageProjectsLockedRef.current = true;
		updateProjectLinks.mutate({
			addProjectIds: projectIdsToAdd,
			removeProjectIds: projectIdsToRemove,
		});
	};

	const actionsDisabled = !primary || isLoading || Boolean(bindingsError || projectsError);
	const header = (
		<PageHeader
			title="Projects"
			titleAdornment={headerAdornment}
			icon={headerIcon}
			description="Projects linked to this Agent."
			actions={
				<>
					<CreateProjectDialog
						agentId={agentId}
						onCreated={async (project) => {
							await onChanged();
							const returnTarget = resourceCollectionTarget(navigationScope, "projects");
							const openHref = `${projectDetailHref(project.id)}?from=${encodeURIComponent(returnTarget.href)}`;
							toast.success("Project created and linked", {
								description: "This Agent can use its Skills and attached Vaults immediately.",
								action: {
									label: "Open project",
									onClick: () => void router.navigate({ href: openHref }),
								},
							});
						}}
					>
						<Button size="sm" variant="outline" disabled={actionsDisabled}>
							<Plus className="size-3.5" />
							Create project
						</Button>
					</CreateProjectDialog>
					<Button
						size="sm"
						disabled={actionsDisabled}
						onClick={() => {
							setManagedProjectIds(new Set(contexts.map((binding) => binding.project_id)));
							setManageOpen(true);
						}}
					>
						<Link2 className="size-3.5" />
						Manage projects
					</Button>
				</>
			}
		/>
	);

	if (isLoading) {
		return (
			<div className="space-y-6" data-testid="agent-projects-loading">
				{header}
				<div className={HERO_GRID_CLASS}>
					{Array.from({ length: 3 }).map((_, index) => (
						<ProjectResourceCardSkeleton key={index} />
					))}
				</div>
			</div>
		);
	}

	if (bindingsError) {
		return (
			<div className="space-y-6">
				{header}
				<ApiErrorPanel
					error={bindingsError}
					onRetry={onRetryBindings}
					title="Couldn't load Projects"
				/>
			</div>
		);
	}

	if (projectsError) {
		return (
			<div className="space-y-6">
				{header}
				<ApiErrorPanel
					error={projectsError}
					onRetry={onRetryProjects}
					title="Couldn't load Projects"
				/>
			</div>
		);
	}

	return (
		<div className="space-y-6" data-testid="agent-project-stack">
			{header}

			{!primary ? (
				<EmptyState variant="inset" description="This Agent's Workspace is not available yet." />
			) : contexts.length === 0 ? (
				<EmptyState
					variant="inset"
					description="No Projects are linked yet. Link one to let this Agent use its Skills and attached Vaults."
				/>
			) : (
				<ol
					className={HERO_GRID_CLASS}
					aria-label="Linked Projects"
					data-testid="agent-project-grid"
				>
					{contexts.map((binding) => {
						const project = projectsById.get(binding.project_id);
						return (
							<li
								key={binding.id}
								className="min-w-0"
								data-binding-type={binding.binding_type}
								data-testid="agent-project-card"
							>
								{project ? (
									<ProjectResourceCard
										project={project}
										navigationScope={navigationScope}
										footer={[
											formatResourceCount(project.skill_count, "skill"),
											formatResourceCount(project.vault_count, "vault"),
										]}
										actions={
											project.is_owner !== false && isCustomProject(project) ? (
												<ProjectActions project={project} onChanged={onChanged} />
											) : undefined
										}
									/>
								) : (
									<UnavailableProjectResourceCard />
								)}
							</li>
						);
					})}
				</ol>
			)}

			<Dialog
				open={manageOpen}
				onOpenChange={setManageOpen}
				onOpenChangeComplete={(open) => {
					if (!open) setManagedProjectIds(new Set());
				}}
			>
				<DialogContent className="sm:max-w-lg" data-testid="agent-project-add-dialog">
					<DialogHeader>
						<DialogTitle>Manage projects</DialogTitle>
						<DialogDescription>Choose which Projects this Agent can use.</DialogDescription>
					</DialogHeader>
					<form
						className="space-y-4"
						onSubmit={(event) => {
							event.preventDefault();
							submitProjectChanges();
						}}
					>
						{manageableProjects.length > 0 ? (
							<div className="max-h-80 divide-y overflow-y-auto rounded-md border">
								{manageableProjects.map((project) => {
									const name = displayProjectName(project);
									const checkboxId = `agent-project-${project.id}`;
									const isSelected = managedProjectIds.has(project.id);
									return (
										<label
											key={project.id}
											htmlFor={checkboxId}
											className="flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-muted/20"
										>
											<Checkbox
												id={checkboxId}
												checked={isSelected}
												disabled={updateProjectLinks.isPending}
												aria-label={`${name} access`}
												onCheckedChange={(checked) => {
													setManagedProjectIds((current) => {
														const next = new Set(current);
														if (checked === true) next.add(project.id);
														else next.delete(project.id);
														return next;
													});
												}}
											/>
											<ProjectIdentity
												project={project}
												showKind={false}
												className="min-w-0 flex-1"
											/>
										</label>
									);
								})}
							</div>
						) : (
							<p className="text-sm text-muted-foreground">No Projects are available.</p>
						)}
						<DialogFooter>
							<Button type="button" variant="ghost" onClick={() => setManageOpen(false)}>
								Cancel
							</Button>
							<Button type="submit" disabled={!hasProjectChanges || updateProjectLinks.isPending}>
								{updateProjectLinks.isPending ? (
									<Spinner className="size-3.5" />
								) : (
									<Save className="size-3.5" />
								)}
								Save changes
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
		</div>
	);
}
