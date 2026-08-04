"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
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
import { ListToolbar } from "@/components/list-toolbar";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { AgentRouteSearch } from "@/lib/agent-routes";
import { toastApiError, unwrap, useApi, useOpenApi } from "@/lib/api";
import type { components } from "@/lib/api-schemas";
import { shouldBlockQueryError } from "@/lib/query-state";
import { agentResourceScope, type ResourceNavigationScope } from "@/lib/resource-navigation";
import { errorMessage } from "@/lib/utils";

type ProjectRow = components["schemas"]["ProjectResponse"];

export function AgentProjectsTab({
	agentId,
	routeSearch,
	enabled = true,
}: {
	agentId: string;
	routeSearch: AgentRouteSearch;
	enabled?: boolean;
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
	onChanged: () => void;
}) {
	const api = useApi();
	const [addOpen, setAddOpen] = useState(false);
	const [addDialogGeneration, setAddDialogGeneration] = useState(0);
	const orderedBindings = orderedAgentProjectBindings(bindings);
	const primary = orderedBindings.find((binding) => binding.binding_type === "primary") ?? null;
	const contexts = orderedBindings.filter((binding) => binding.binding_type === "context");
	const effectiveBindings = primary ? [primary, ...contexts] : [];
	const projectsById = useMemo(
		() => new Map(projects.map((project) => [project.id, project])),
		[projects],
	);
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
			toast.success("Project removed");
		},
		onError: toastApiError("Couldn't remove project"),
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
		onError: toastApiError("Couldn't reorder projects"),
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

	if (isLoading) {
		return (
			<div className="space-y-4" data-testid="agent-projects-loading">
				<div className="flex justify-end">
					<Skeleton className="h-8 w-28 rounded-md" />
				</div>
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
			<ApiErrorPanel
				error={bindingsError}
				onRetry={onRetryBindings}
				title="Couldn't load agent Projects"
			/>
		);
	}

	if (projectsError) {
		return (
			<ApiErrorPanel
				error={projectsError}
				onRetry={onRetryProjects}
				title="Couldn't load Projects"
			/>
		);
	}

	return (
		<div className="space-y-4" data-testid="agent-project-stack">
			<ListToolbar
				actions={
					<Button size="sm" disabled={!primary} onClick={() => setAddOpen(true)}>
						<Plus className="size-3.5" />
						Add Project
					</Button>
				}
			/>

			{effectiveBindings.length === 0 ? (
				<EmptyState variant="inset" description="The Agent Project is not available yet." />
			) : (
				<ol
					className={HERO_GRID_CLASS}
					aria-label="Effective Project read order"
					data-testid="agent-project-grid"
				>
					{effectiveBindings.map((binding, position) => {
						const project = projectsById.get(binding.project_id);
						const projectName = project ? displayProjectName(project) : binding.project_id;
						const isRemoving = removeBinding.isPending && removeBinding.variables === binding.id;
						const contextIndex = binding.binding_type === "context" ? position - 1 : -1;
						return (
							<li
								key={binding.id}
								className="min-w-0"
								data-binding-type={binding.binding_type}
								data-testid="agent-project-card"
							>
								<AgentProjectCard
									binding={binding}
									project={project}
									position={position}
									navigationScope={navigationScope}
									actions={
										binding.binding_type === "context" ? (
											<div className="flex items-center gap-0.5 opacity-100 transition-opacity sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100">
												<Button
													variant="ghost"
													size="icon-sm"
													disabled={contextIndex === 0 || reorder.isPending}
													onClick={() => moveContext(binding.id, -1)}
													title="Move up"
													aria-label={`Move ${projectName} up`}
												>
													<ArrowUp className="size-3.5" />
												</Button>
												<Button
													variant="ghost"
													size="icon-sm"
													disabled={contextIndex === contexts.length - 1 || reorder.isPending}
													onClick={() => moveContext(binding.id, 1)}
													title="Move down"
													aria-label={`Move ${projectName} down`}
												>
													<ArrowDown className="size-3.5" />
												</Button>
												<ConfirmAction
													title="Remove this Project?"
													description={
														<>
															<p>{projectName} will no longer be available to this agent.</p>
															<p>The Project and its resources are not deleted.</p>
														</>
													}
													confirmLabel="Remove Project"
													destructive
													onConfirm={() => removeBinding.mutate(binding.id)}
												>
													<Button
														variant="ghost"
														size="icon-sm"
														disabled={isRemoving}
														title="Remove"
														aria-label={`Remove ${projectName}`}
													>
														{isRemoving ? (
															<Spinner className="size-3.5" />
														) : (
															<Trash2 className="size-3.5 text-destructive" />
														)}
													</Button>
												</ConfirmAction>
											</div>
										) : null
									}
								/>
							</li>
						);
					})}
				</ol>
			)}

			<Dialog
				open={addOpen}
				onOpenChange={setAddOpen}
				onOpenChangeComplete={(open) => {
					if (!open) setAddDialogGeneration((generation) => generation + 1);
				}}
			>
				<AgentProjectAddDialog
					key={addDialogGeneration}
					agentId={agentId}
					bindings={bindings}
					projects={projects}
					onOpenChange={setAddOpen}
					onChanged={onChanged}
				/>
			</Dialog>
		</div>
	);
}

type AddProjectRequest = { kind: "existing"; projectId: string } | { kind: "create"; name: string };

class ProjectCreatedButNotAddedError extends Error {
	constructor(
		readonly project: ProjectRow,
		readonly linkError: unknown,
	) {
		super("Project created but could not be added to the Agent");
		this.name = "ProjectCreatedButNotAddedError";
	}
}

export function AgentProjectAddDialog({
	agentId,
	bindings,
	projects,
	onOpenChange,
	onChanged,
	onAdded,
}: {
	agentId: string;
	bindings: AgentProjectBinding[];
	projects: ProjectRow[];
	onOpenChange: (open: boolean) => void;
	onChanged: () => void;
	onAdded?: (projectId: string) => void;
}) {
	const api = useApi();
	const queryClient = useQueryClient();
	const [mode, setMode] = useState<"create" | "existing">("create");
	const [projectName, setProjectName] = useState("");
	const [contextProjectId, setContextProjectId] = useState("");
	const [createdProjectToRetry, setCreatedProjectToRetry] = useState<ProjectRow | null>(null);
	const contextChoices = projects.filter(
		(project) =>
			isCustomProject(project) && !bindings.some((binding) => binding.project_id === project.id),
	);

	const addProject = useMutation({
		mutationFn: async (request: AddProjectRequest) => {
			let createdProject: ProjectRow | null = null;
			if (request.kind === "create") {
				createdProject = await unwrap(
					await api.POST("/v1/projects", {
						body: { name: request.name },
					}),
				);
			}
			const projectId = request.kind === "existing" ? request.projectId : createdProject?.id;
			if (!projectId) throw new Error("The new Project did not return an id.");
			try {
				await unwrap(
					await api.POST("/v1/agents/{agent_id}/project-bindings/context", {
						params: { path: { agent_id: agentId } },
						body: { project_id: projectId },
					}),
				);
			} catch (error) {
				if (request.kind === "create" && createdProject) {
					throw new ProjectCreatedButNotAddedError(createdProject, error);
				}
				throw error;
			}
			return { projectId, created: request.kind === "create" };
		},
		onSuccess: async ({ projectId, created }) => {
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: agentProjectBindingsQueryKey(agentId) }),
				queryClient.invalidateQueries({ queryKey: ["get", "/v1/projects"] }),
			]);
			setProjectName("");
			setContextProjectId("");
			setCreatedProjectToRetry(null);
			onOpenChange(false);
			onChanged();
			toast.success(created ? "Project created and added" : "Project added");
			onAdded?.(projectId);
		},
		onError: (error) => {
			if (error instanceof ProjectCreatedButNotAddedError) {
				setCreatedProjectToRetry(error.project);
				void queryClient.invalidateQueries({ queryKey: ["get", "/v1/projects"] });
				toast.error("Project created, but couldn't add it to this Agent", {
					description: errorMessage(error.linkError),
				});
				return;
			}
			toast.error("Couldn't add project", { description: errorMessage(error) });
		},
	});
	return (
		<DialogContent className="sm:max-w-md" data-testid="agent-project-add-dialog">
			<DialogHeader>
				<DialogTitle>Add Project</DialogTitle>
				<DialogDescription>
					Create a Project for this Agent, or add a Custom or shared Project you already use.
				</DialogDescription>
			</DialogHeader>
			<Tabs
				value={mode}
				onValueChange={(value) => {
					if (value === "create" || value === "existing") setMode(value);
				}}
			>
				<TabsList className="grid w-full grid-cols-2">
					<TabsTrigger value="create">New Project</TabsTrigger>
					<TabsTrigger value="existing">Existing Project</TabsTrigger>
				</TabsList>
				<TabsContent value="create">
					<form
						className="space-y-4 pt-2"
						onSubmit={(event) => {
							event.preventDefault();
							const name = projectName.trim();
							if (!name || addProject.isPending) return;
							addProject.mutate({ kind: "create", name });
						}}
					>
						<div className="space-y-1.5">
							<Label htmlFor="agent-project-name">Project name</Label>
							<Input
								id="agent-project-name"
								value={projectName}
								onChange={(event) => setProjectName(event.target.value)}
								placeholder="Project name…"
								maxLength={200}
								autoComplete="off"
								disabled={addProject.isPending}
							/>
						</div>
						{createdProjectToRetry ? (
							<div className="rounded-md border bg-muted/30 p-3 text-sm">
								<p className="font-medium">
									{displayProjectName(createdProjectToRetry)} was created.
								</p>
								<p className="mt-1 text-muted-foreground">
									Adding it to this Agent failed. Retry without creating another Project.
								</p>
								<Button
									type="button"
									variant="outline"
									size="sm"
									className="mt-3"
									disabled={addProject.isPending}
									onClick={() =>
										addProject.mutate({ kind: "existing", projectId: createdProjectToRetry.id })
									}
								>
									Retry adding Project
								</Button>
							</div>
						) : null}
						<DialogFooter>
							<Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
								Cancel
							</Button>
							<Button type="submit" disabled={!projectName.trim() || addProject.isPending}>
								{addProject.isPending ? (
									<Spinner className="size-3.5" />
								) : (
									<Plus className="size-3.5" />
								)}
								Create and add
							</Button>
						</DialogFooter>
					</form>
				</TabsContent>
				<TabsContent value="existing">
					<form
						className="space-y-4 pt-2"
						onSubmit={(event) => {
							event.preventDefault();
							if (!contextProjectId || addProject.isPending) return;
							addProject.mutate({ kind: "existing", projectId: contextProjectId });
						}}
					>
						{contextChoices.length > 0 ? (
							<ProjectCompactPicker
								projects={contextChoices}
								value={contextProjectId}
								onValueChange={setContextProjectId}
								placeholder="Choose a Project…"
								ariaLabel="Project to add"
								disabled={addProject.isPending}
							/>
						) : (
							<p className="text-sm text-muted-foreground">
								Every available Custom or shared Project is already linked to this Agent.
							</p>
						)}
						<DialogFooter>
							<Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
								Cancel
							</Button>
							<Button type="submit" disabled={!contextProjectId || addProject.isPending}>
								{addProject.isPending ? (
									<Spinner className="size-3.5" />
								) : (
									<Plus className="size-3.5" />
								)}
								Add Project
							</Button>
						</DialogFooter>
					</form>
				</TabsContent>
			</Tabs>
		</DialogContent>
	);
}

function AgentProjectCard({
	binding,
	project,
	position,
	navigationScope,
	actions,
}: {
	binding: AgentProjectBinding;
	project: ProjectRow | undefined;
	position: number;
	navigationScope: ResourceNavigationScope;
	actions?: React.ReactNode;
}) {
	const footer = [
		`Read order ${position + 1}`,
		binding.binding_type === "primary" ? "Default write destination" : null,
	];
	if (!project) {
		return (
			<UnavailableProjectResourceCard
				projectId={binding.project_id}
				footer={footer}
				actions={actions}
			/>
		);
	}
	return (
		<ProjectResourceCard
			project={project}
			footer={footer}
			actions={actions}
			showKind
			navigationScope={navigationScope}
		/>
	);
}
