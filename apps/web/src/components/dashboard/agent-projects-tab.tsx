"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { ArrowDown, ArrowUp, Link2, Plus, Trash2 } from "lucide-react";
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
import {
	displayProjectName,
	isCustomProject,
	ProjectCompactPicker,
} from "@/components/projects/project-metadata";
import {
	ProjectResourceCard,
	ProjectResourceCardSkeleton,
	UnavailableProjectResourceCard,
} from "@/components/projects/project-resource-card";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import type { AgentRouteSearch } from "@/lib/agent-routes";
import { unwrap, useApi, useOpenApi } from "@/lib/api";
import { normalizeApiError } from "@/lib/api-errors";
import type { components } from "@/lib/api-schemas";
import { projectDetailHref } from "@/lib/project-resource-model";
import { shouldBlockQueryError } from "@/lib/query-state";
import {
	agentResourceScope,
	type ResourceNavigationScope,
	resourceCollectionTarget,
} from "@/lib/resource-navigation";

type ProjectRow = components["schemas"]["ProjectResponse"];
type ProjectCreate = components["schemas"]["ProjectCreate"];

export function AgentProjectsTab({
	agentId,
	routeSearch,
	enabled = true,
	headerIcon,
	headerAdornment,
}: {
	agentId: string;
	routeSearch: AgentRouteSearch;
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

	const navigationScope = agentResourceScope(agentId, routeSearch);
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
			onChanged={() => {
				void queryClient.invalidateQueries({ queryKey: agentProjectBindingsQueryKey(agentId) });
				void queryClient.invalidateQueries({ queryKey: ["get", "/v1/projects"] });
			}}
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
	onChanged: () => void;
}) {
	const api = useApi();
	const router = useRouter();
	const [contextProjectId, setContextProjectId] = useState("");
	const [linkOpen, setLinkOpen] = useState(false);
	const [createOpen, setCreateOpen] = useState(false);
	const [newProjectName, setNewProjectName] = useState("");
	const [newProjectDescription, setNewProjectDescription] = useState("");
	// React Query pending state is post-render. These refs reject a second
	// submit synchronously, before another mutation can queue in the same frame.
	const linkExistingLockedRef = useRef(false);
	const createProjectLockedRef = useRef(false);
	const orderedBindings = orderedAgentProjectBindings(bindings);
	const primary = orderedBindings.find((binding) => binding.binding_type === "primary") ?? null;
	const contexts = orderedBindings.filter((binding) => binding.binding_type === "context");
	const projectsById = useMemo(
		() => new Map(projects.map((project) => [project.id, project])),
		[projects],
	);
	const contextChoices = projects.filter(
		(project) =>
			isCustomProject(project) && !bindings.some((binding) => binding.project_id === project.id),
	);

	const linkContext = useMutation({
		mutationFn: async (projectId: string) => {
			await unwrap(
				await api.POST("/v1/agents/{agent_id}/project-bindings/context", {
					params: { path: { agent_id: agentId } },
					body: { project_id: projectId },
				}),
			);
		},
		onSuccess: () => {
			setContextProjectId("");
			setLinkOpen(false);
			onChanged();
			toast.success("Project linked");
		},
		onError: (error) =>
			toast.error("Couldn't link project", { description: normalizeApiError(error) }),
		onSettled: () => {
			linkExistingLockedRef.current = false;
		},
	});

	const createProject = useMutation({
		mutationFn: async (body: ProjectCreate) => unwrap(await api.POST("/v1/projects", { body })),
		onSuccess: (project) => {
			setNewProjectName("");
			setNewProjectDescription("");
			setCreateOpen(false);
			onChanged();
			const returnTarget = resourceCollectionTarget(navigationScope, "projects");
			const openHref = `${projectDetailHref(project.id)}?from=${encodeURIComponent(returnTarget.href)}`;
			toast.success("Project created", {
				description: "Link it when this Agent should use its Skills and attached Vaults.",
				action: {
					label: "Open project",
					onClick: () => void router.navigate({ href: openHref }),
				},
			});
		},
		onError: (error) =>
			toast.error("Couldn't create project", { description: normalizeApiError(error) }),
		onSettled: () => {
			createProjectLockedRef.current = false;
		},
	});

	const submitExistingProjectLink = () => {
		if (!contextProjectId || linkExistingLockedRef.current) return;
		linkExistingLockedRef.current = true;
		linkContext.mutate(contextProjectId);
	};

	const submitCreateProject = () => {
		const name = newProjectName.trim();
		if (!name || createProjectLockedRef.current) return;
		createProjectLockedRef.current = true;
		createProject.mutate({
			name,
			description: newProjectDescription.trim() || null,
		});
	};

	const removeBinding = useMutation({
		mutationFn: async (bindingId: string) => {
			await unwrap(
				await api.DELETE("/v1/agents/{agent_id}/project-bindings/{binding_id}", {
					params: { path: { agent_id: agentId, binding_id: bindingId } },
				}),
			);
		},
		onSuccess: () => {
			onChanged();
			toast.success("Project unlinked");
		},
		onError: (error) =>
			toast.error("Couldn't unlink project", { description: normalizeApiError(error) }),
	});

	const reorder = useMutation({
		mutationFn: async (items: Array<{ binding_id: string; priority: number }>) => {
			await unwrap(
				await api.PATCH("/v1/agents/{agent_id}/project-bindings/context/reorder", {
					params: { path: { agent_id: agentId } },
					body: { items },
				}),
			);
		},
		onSuccess: () => {
			onChanged();
			toast.success("Project order updated");
		},
		onError: (error) =>
			toast.error("Couldn't update Project order", {
				description: normalizeApiError(error),
			}),
	});

	const moveContext = (bindingId: string, direction: -1 | 1) => {
		const index = contexts.findIndex((binding) => binding.id === bindingId);
		const targetIndex = index + direction;
		if (index < 0 || targetIndex < 0 || targetIndex >= contexts.length) return;
		const next = contexts.slice();
		const [item] = next.splice(index, 1);
		if (!item) return;
		next.splice(targetIndex, 0, item);
		reorder.mutate(next.map((binding, idx) => ({ binding_id: binding.id, priority: idx + 1 })));
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
					<Button
						size="sm"
						variant="outline"
						disabled={actionsDisabled}
						onClick={() => setCreateOpen(true)}
					>
						<Plus className="size-3.5" />
						Create project
					</Button>
					<Button
						size="sm"
						disabled={actionsDisabled}
						onClick={() => {
							setContextProjectId("");
							setLinkOpen(true);
						}}
					>
						<Link2 className="size-3.5" />
						Link project
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
					aria-label="Linked Projects in use order"
					data-testid="agent-project-grid"
				>
					{contexts.map((binding, position) => {
						const project = projectsById.get(binding.project_id);
						const projectName = project ? displayProjectName(project) : "Unavailable Project";
						const isRemoving = removeBinding.isPending && removeBinding.variables === binding.id;
						return (
							<li
								key={binding.id}
								className="min-w-0"
								data-binding-type={binding.binding_type}
								data-testid="agent-project-card"
							>
								<AgentProjectCard
									project={project}
									position={position}
									navigationScope={navigationScope}
									actions={
										<div className="flex items-center gap-0.5">
											<Button
												variant="ghost"
												size="icon-sm"
												disabled={position === 0 || reorder.isPending}
												onClick={() => moveContext(binding.id, -1)}
												title="Move up"
												aria-label={`Move ${projectName} up`}
											>
												<ArrowUp className="size-3.5" />
											</Button>
											<Button
												variant="ghost"
												size="icon-sm"
												disabled={position === contexts.length - 1 || reorder.isPending}
												onClick={() => moveContext(binding.id, 1)}
												title="Move down"
												aria-label={`Move ${projectName} down`}
											>
												<ArrowDown className="size-3.5" />
											</Button>
											<ConfirmAction
												title="Unlink this Project?"
												description={
													<>
														<p>
															This Agent will stop using {projectName}&apos;s Skills and attached
															Vaults.
														</p>
														<p>The Project and its resources remain unchanged.</p>
													</>
												}
												confirmLabel="Unlink project"
												destructive
												onConfirm={() => removeBinding.mutateAsync(binding.id)}
											>
												<Button
													variant="ghost"
													size="icon-sm"
													disabled={isRemoving}
													title="Unlink project"
													aria-label={`Unlink ${projectName}`}
												>
													{isRemoving ? (
														<Spinner className="size-3.5" />
													) : (
														<Trash2 className="size-3.5 text-destructive" />
													)}
												</Button>
											</ConfirmAction>
										</div>
									}
								/>
							</li>
						);
					})}
				</ol>
			)}

			<Dialog
				open={linkOpen}
				onOpenChange={setLinkOpen}
				onOpenChangeComplete={(open) => {
					if (!open) setContextProjectId("");
				}}
			>
				<DialogContent className="sm:max-w-md" data-testid="agent-project-add-dialog">
					<DialogHeader>
						<DialogTitle>Link project</DialogTitle>
						<DialogDescription>
							Choose a Project. This Agent will use its Skills and attached Vaults together.
						</DialogDescription>
					</DialogHeader>
					<form
						className="space-y-4"
						onSubmit={(event) => {
							event.preventDefault();
							submitExistingProjectLink();
						}}
					>
						{contextChoices.length > 0 ? (
							<ProjectCompactPicker
								projects={contextChoices}
								value={contextProjectId}
								onValueChange={setContextProjectId}
								placeholder="Choose a Project…"
								ariaLabel="Project to link"
								disabled={linkContext.isPending}
							/>
						) : (
							<p className="text-sm text-muted-foreground">No Projects are available to link.</p>
						)}
						<DialogFooter>
							<Button type="button" variant="ghost" onClick={() => setLinkOpen(false)}>
								Cancel
							</Button>
							<Button type="submit" disabled={!contextProjectId || linkContext.isPending}>
								{linkContext.isPending ? (
									<Spinner className="size-3.5" />
								) : (
									<Plus className="size-3.5" />
								)}
								Link project
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>

			<Dialog
				open={createOpen}
				onOpenChange={setCreateOpen}
				onOpenChangeComplete={(open) => {
					if (!open) {
						setNewProjectName("");
						setNewProjectDescription("");
					}
				}}
			>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>Create project</DialogTitle>
						<DialogDescription>
							Create a shareable bundle for Skills and attached Vault access. Link it to this Agent
							when it is ready to use.
						</DialogDescription>
					</DialogHeader>
					<form
						className="space-y-4"
						onSubmit={(event) => {
							event.preventDefault();
							submitCreateProject();
						}}
					>
						<div className="space-y-1.5">
							<Label htmlFor="agent-project-name">Name</Label>
							<Input
								id="agent-project-name"
								name="agent-project-name"
								value={newProjectName}
								maxLength={200}
								autoComplete="off"
								placeholder="Project name…"
								onChange={(event) => setNewProjectName(event.target.value)}
							/>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="agent-project-description">Description</Label>
							<Textarea
								id="agent-project-description"
								name="agent-project-description"
								value={newProjectDescription}
								maxLength={2000}
								placeholder="What should Agents use this Project for?"
								autoComplete="off"
								onChange={(event) => setNewProjectDescription(event.target.value)}
								className="min-h-24"
							/>
						</div>
						<DialogFooter>
							<Button type="button" variant="ghost" onClick={() => setCreateOpen(false)}>
								Cancel
							</Button>
							<Button type="submit" disabled={!newProjectName.trim() || createProject.isPending}>
								{createProject.isPending ? <Spinner className="size-3.5" /> : <Plus />}
								Create project
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
		</div>
	);
}

function AgentProjectCard({
	project,
	position,
	navigationScope,
	actions,
}: {
	project: ProjectRow | undefined;
	position: number;
	navigationScope: ResourceNavigationScope;
	actions?: ReactNode;
}) {
	const footer = [`Project order ${position + 1}`];
	if (!project) {
		return <UnavailableProjectResourceCard footer={footer} actions={actions} />;
	}
	return (
		<ProjectResourceCard
			project={project}
			footer={footer}
			actions={actions}
			navigationScope={navigationScope}
		/>
	);
}
