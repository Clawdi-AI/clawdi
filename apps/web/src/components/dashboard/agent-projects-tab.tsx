"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import { ArrowDown, ArrowUp, ExternalLink, Plus, RotateCcw, Trash2 } from "lucide-react";
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
import { ProjectCreateDialog } from "@/components/projects/project-create-dialog";
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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import type { AgentRouteSearch } from "@/lib/agent-routes";
import { ApiError, toastApiError, unwrap, useApi, useOpenApi } from "@/lib/api";
import { formatApiError } from "@/lib/api-errors";
import type { components } from "@/lib/api-schemas";
import { projectDetailHref } from "@/lib/project-resource-model";
import { shouldBlockQueryError } from "@/lib/query-state";
import {
	agentResourceScope,
	projectDetailHrefForScope,
	type ResourceNavigationScope,
} from "@/lib/resource-navigation";

type ProjectRow = components["schemas"]["ProjectResponse"];
type ProjectCreate = components["schemas"]["ProjectCreate"];

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
				void queryClient.invalidateQueries({ queryKey: ["skills"] });
				void queryClient.invalidateQueries({ queryKey: ["vaults", "agent-projects"] });
				void queryClient.invalidateQueries({ queryKey: ["get", "/v1/vault"] });
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
	const router = useRouter();
	const [contextProjectId, setContextProjectId] = useState("");
	const [addOpen, setAddOpen] = useState(false);
	const [createOpen, setCreateOpen] = useState(false);
	const [partiallyCreatedProject, setPartiallyCreatedProject] = useState<{
		project: ProjectRow;
		bindingError: unknown;
	} | null>(null);
	const orderedBindings = orderedAgentProjectBindings(bindings);
	const primary = orderedBindings.find((binding) => binding.binding_type === "primary") ?? null;
	const contexts = orderedBindings.filter((binding) => binding.binding_type === "context");
	const effectiveBindings = primary ? [primary, ...contexts] : [];
	const projectsById = useMemo(
		() => new Map(projects.map((project) => [project.id, project])),
		[projects],
	);
	const contextChoices = projects.filter(
		(project) =>
			isCustomProject(project) && !bindings.some((binding) => binding.project_id === project.id),
	);

	const addContext = useMutation({
		mutationFn: async () => {
			await unwrap(
				await api.POST("/v1/agents/{agent_id}/project-bindings/context", {
					params: { path: { agent_id: agentId } },
					body: { project_id: contextProjectId },
				}),
			);
		},
		onSuccess: () => {
			setContextProjectId("");
			setAddOpen(false);
			onChanged();
			toast.success("Project added", {
				description: "Only this Agent's effective access and read order changed.",
			});
		},
		onError: toastApiError("Couldn't add project"),
	});

	const finishCreatedProject = (project: ProjectRow) => {
		setPartiallyCreatedProject(null);
		setCreateOpen(false);
		onChanged();
		toast.success("Project created and added", {
			description: `${project.name} is an account resource and is now available to this Agent.`,
		});
		void router.navigate({ href: projectDetailHrefForScope(navigationScope, project.id) });
	};

	const createProject = useMutation({
		mutationFn: async (body: ProjectCreate) => {
			const project = unwrap(await api.POST("/v1/projects", { body }));
			try {
				await unwrap(
					await api.POST("/v1/agents/{agent_id}/project-bindings/context", {
						params: { path: { agent_id: agentId } },
						body: { project_id: project.id },
					}),
				);
				return { project, bindingError: null };
			} catch (bindingError) {
				return { project, bindingError };
			}
		},
		onSuccess: ({ project, bindingError }) => {
			onChanged();
			if (bindingError) {
				setPartiallyCreatedProject({ project, bindingError });
				toast.warning("Project created, but not added to this Agent", {
					description: "The Project remains safely available in the resource library. Retry here.",
				});
				return;
			}
			finishCreatedProject(project);
		},
		onError: toastApiError("Couldn't create Project"),
	});

	const retryCreatedProjectBinding = useMutation({
		mutationFn: async (project: ProjectRow) => {
			await unwrap(
				await api.POST("/v1/agents/{agent_id}/project-bindings/context", {
					params: { path: { agent_id: agentId } },
					body: { project_id: project.id },
				}),
			);
			return project;
		},
		onSuccess: finishCreatedProject,
		onError: (bindingError) => {
			setPartiallyCreatedProject((current) => (current ? { ...current, bindingError } : current));
			toastApiError("Couldn't add Project to this Agent")(bindingError);
		},
	});

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
			toast.success("Project removed", {
				description: "Only this Agent lost access. The Project and its resources still exist.",
			});
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
			toast.success("Project order updated", {
				description: "Only this Agent's Project read order changed.",
			});
		},
		onError: toastApiError("Couldn't reorder projects"),
	});

	const moveContext = (bindingId: string, direction: -1 | 1) => {
		if (reorder.isPending) return;
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
					<>
						<Button
							size="sm"
							disabled={!primary}
							onClick={() => {
								setPartiallyCreatedProject(null);
								setCreateOpen(true);
							}}
						>
							<Plus className="size-3.5" />
							New Project
						</Button>
						<Button
							size="sm"
							variant="outline"
							disabled={!primary}
							onClick={() => {
								setContextProjectId("");
								setAddOpen(true);
							}}
						>
							<Plus className="size-3.5" />
							Add existing Project
						</Button>
					</>
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
													onConfirm={() => {
														if (!removeBinding.isPending) removeBinding.mutate(binding.id);
													}}
												>
													<Button
														variant="ghost"
														size="icon-sm"
														disabled={removeBinding.isPending}
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

			<ProjectCreateDialog
				open={createOpen}
				onOpenChange={(nextOpen) => {
					if (createProject.isPending || retryCreatedProjectBinding.isPending) return;
					setCreateOpen(nextOpen);
					if (!nextOpen) setPartiallyCreatedProject(null);
				}}
				onCreate={(body) => createProject.mutateAsync(body)}
				isPending={createProject.isPending}
				formLocked={partiallyCreatedProject !== null}
				title="New Project for this Agent"
				description="Creates an account-owned Custom Project, then adds it to this Agent's effective access scope."
				feedback={
					partiallyCreatedProject ? (
						<Alert variant="destructive">
							<AlertTitle>Project created; Agent access still needs attention</AlertTitle>
							<AlertDescription className="space-y-3">
								<p>
									{partiallyCreatedProject.project.name} exists in the resource library, but adding
									it to this Agent failed:{" "}
									{partiallyCreatedProject.bindingError instanceof ApiError
										? formatApiError(partiallyCreatedProject.bindingError.detail)
										: "The request could not be completed. Try adding it again."}
								</p>
								<div className="flex flex-wrap gap-2">
									<Button
										type="button"
										size="sm"
										disabled={retryCreatedProjectBinding.isPending}
										onClick={() =>
											retryCreatedProjectBinding.mutate(partiallyCreatedProject.project)
										}
									>
										{retryCreatedProjectBinding.isPending ? (
											<Spinner className="size-3.5" />
										) : (
											<RotateCcw className="size-3.5" />
										)}
										Retry adding to Agent
									</Button>
									<Button
										type="button"
										variant="ghost"
										size="sm"
										render={<Link to={projectDetailHref(partiallyCreatedProject.project.id)} />}
										nativeButton={false}
									>
										<ExternalLink className="size-3.5" />
										Open in resource library
									</Button>
								</div>
							</AlertDescription>
						</Alert>
					) : null
				}
			/>

			<Dialog
				open={addOpen}
				onOpenChange={(nextOpen) => {
					if (!addContext.isPending) setAddOpen(nextOpen);
				}}
				onOpenChangeComplete={(open) => {
					if (!open) setContextProjectId("");
				}}
			>
				<DialogContent className="sm:max-w-md" data-testid="agent-project-add-dialog">
					<DialogHeader>
						<DialogTitle>Add existing Project</DialogTitle>
						<DialogDescription>
							Add a Custom or shared Project to this agent's read order.
						</DialogDescription>
					</DialogHeader>
					<form
						className="space-y-4"
						onSubmit={(event) => {
							event.preventDefault();
							if (!contextProjectId || addContext.isPending) return;
							addContext.mutate();
						}}
					>
						{contextChoices.length > 0 ? (
							<ProjectCompactPicker
								projects={contextChoices}
								value={contextProjectId}
								onValueChange={setContextProjectId}
								placeholder="Choose a Project…"
								ariaLabel="Project to add"
								disabled={addContext.isPending}
							/>
						) : (
							<p className="text-sm text-muted-foreground">
								No Custom or shared Projects are available to add.
							</p>
						)}
						<DialogFooter>
							<Button
								type="button"
								variant="ghost"
								disabled={addContext.isPending}
								onClick={() => setAddOpen(false)}
							>
								Cancel
							</Button>
							<Button type="submit" disabled={!contextProjectId || addContext.isPending}>
								{addContext.isPending ? (
									<Spinner className="size-3.5" />
								) : (
									<Plus className="size-3.5" />
								)}
								Add existing Project
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
		</div>
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
	const footer = [`Read order ${position + 1}`];
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
			badges={
				binding.binding_type === "primary" ? <Badge variant="secondary">Default</Badge> : null
			}
			showKind
			navigationScope={navigationScope}
		/>
	);
}
