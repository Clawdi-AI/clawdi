"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Link2, Plus, Trash2 } from "lucide-react";
import { useMemo, useRef, useState } from "react";
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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import type { AgentRouteSearch } from "@/lib/agent-routes";
import { unwrap, useApi, useOpenApi } from "@/lib/api";
import type { components } from "@/lib/api-schemas";
import { shouldBlockQueryError } from "@/lib/query-state";
import { agentResourceScope, type ResourceNavigationScope } from "@/lib/resource-navigation";
import { errorMessage } from "@/lib/utils";

type ProjectRow = components["schemas"]["ProjectResponse"];

class ProjectCreatedButNotLinkedError extends Error {
	constructor(
		readonly project: ProjectRow,
		readonly linkError: unknown,
	) {
		super(`Project ${displayProjectName(project)} was created but could not be linked`, {
			cause: linkError,
		});
		this.name = "ProjectCreatedButNotLinkedError";
	}
}

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
	const [contextProjectId, setContextProjectId] = useState("");
	const [linkOpen, setLinkOpen] = useState(false);
	const [createOpen, setCreateOpen] = useState(false);
	const [newProjectName, setNewProjectName] = useState("");
	const [createdProjectAwaitingLink, setCreatedProjectAwaitingLink] = useState<ProjectRow | null>(
		null,
	);
	const [initialLinkError, setInitialLinkError] = useState<unknown>(null);
	// React Query pending state is post-render. These refs reject a second
	// submit synchronously, before another mutation can queue in the same frame.
	const linkExistingLockedRef = useRef(false);
	const createAndLinkLockedRef = useRef(false);
	const retryLinkLockedRef = useRef(false);
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
		onSuccess: (_result, projectId) => {
			if (createdProjectAwaitingLink?.id === projectId) {
				setCreatedProjectAwaitingLink(null);
				setInitialLinkError(null);
			}
			setContextProjectId("");
			setLinkOpen(false);
			onChanged();
			toast.success("Project linked");
		},
		onError: (error) => toast.error("Couldn't link project", { description: errorMessage(error) }),
		onSettled: () => {
			linkExistingLockedRef.current = false;
		},
	});

	const createAndLink = useMutation({
		mutationFn: async (name: string) => {
			const created = unwrap(await api.POST("/v1/projects", { body: { name } }));
			try {
				await unwrap(
					await api.POST("/v1/agents/{agent_id}/project-bindings/context", {
						params: { path: { agent_id: agentId } },
						body: { project_id: created.id },
					}),
				);
			} catch (error) {
				throw new ProjectCreatedButNotLinkedError(created, error);
			}
			return created;
		},
		onSuccess: (project) => {
			setCreatedProjectAwaitingLink(null);
			setInitialLinkError(null);
			setNewProjectName("");
			setCreateOpen(false);
			onChanged();
			toast.success("Project created and linked", {
				description: `${displayProjectName(project)} is now in this Agent's Project list.`,
			});
		},
		onError: (error) => {
			if (error instanceof ProjectCreatedButNotLinkedError) {
				setCreatedProjectAwaitingLink(error.project);
				setInitialLinkError(error.linkError);
				onChanged();
				return;
			}
			toast.error("Couldn't create project", { description: errorMessage(error) });
		},
		onSettled: () => {
			createAndLinkLockedRef.current = false;
		},
	});

	const retryCreatedProjectLink = useMutation({
		mutationFn: async (project: ProjectRow) =>
			unwrap(
				await api.POST("/v1/agents/{agent_id}/project-bindings/context", {
					params: { path: { agent_id: agentId } },
					body: { project_id: project.id },
				}),
			),
		onSuccess: () => {
			const projectName = createdProjectAwaitingLink
				? displayProjectName(createdProjectAwaitingLink)
				: "Project";
			setCreatedProjectAwaitingLink(null);
			setInitialLinkError(null);
			setNewProjectName("");
			setCreateOpen(false);
			onChanged();
			toast.success("Project linked", {
				description: `${projectName} is now in this Agent's Project list.`,
			});
		},
		onSettled: () => {
			retryLinkLockedRef.current = false;
		},
	});

	const submitExistingProjectLink = () => {
		if (!contextProjectId || linkExistingLockedRef.current) return;
		linkExistingLockedRef.current = true;
		linkContext.mutate(contextProjectId);
	};

	const submitCreateAndLink = () => {
		const name = newProjectName.trim();
		if (!name || createAndLinkLockedRef.current) return;
		createAndLinkLockedRef.current = true;
		createAndLink.mutate(name);
	};

	const submitRetryLink = () => {
		if (!createdProjectAwaitingLink || retryLinkLockedRef.current) return;
		retryLinkLockedRef.current = true;
		retryCreatedProjectLink.mutate(createdProjectAwaitingLink);
	};

	const keepCreatedProjectUnlinked = () => {
		if (!createdProjectAwaitingLink) return;
		const projectName = displayProjectName(createdProjectAwaitingLink);
		setCreatedProjectAwaitingLink(null);
		setInitialLinkError(null);
		setNewProjectName("");
		setCreateOpen(false);
		onChanged();
		toast.success("Project kept unlinked", {
			description: `${projectName} remains available in your Project library.`,
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
			toast.error("Couldn't unlink project", { description: errorMessage(error) }),
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
				description: errorMessage(error),
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
				title="Couldn't load Projects"
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
					<div className="flex flex-wrap justify-end gap-2">
						<Button size="sm" disabled={!primary} onClick={() => setCreateOpen(true)}>
							<Plus className="size-3.5" />
							Create project
						</Button>
						<Button
							size="sm"
							variant="outline"
							disabled={!primary}
							onClick={() => {
								setContextProjectId("");
								setLinkOpen(true);
							}}
						>
							<Link2 className="size-3.5" />
							Link project
						</Button>
					</div>
				}
			/>

			{!primary ? (
				<EmptyState variant="inset" description="This Agent's Workspace is not available yet." />
			) : contexts.length === 0 ? (
				<EmptyState
					variant="inset"
					description="No Projects are linked yet. Linking a Project makes its attached Vaults available to this Agent; Skills remain separate."
				/>
			) : (
				<ol
					className={HERO_GRID_CLASS}
					aria-label="Linked Projects in Vault priority order"
					data-testid="agent-project-grid"
				>
					{contexts.map((binding, position) => {
						const project = projectsById.get(binding.project_id);
						const projectName = project ? displayProjectName(project) : binding.project_id;
						const isRemoving = removeBinding.isPending && removeBinding.variables === binding.id;
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
										<div className="flex items-center gap-0.5 opacity-100 transition-opacity sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100">
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
														<p>This Agent will no longer use Vaults through {projectName}.</p>
														<p>
															Its Skills stay stored in the Project, and its Vault attachments are
															unchanged.
														</p>
													</>
												}
												confirmLabel="Unlink project"
												destructive
												onConfirm={() => removeBinding.mutate(binding.id)}
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
							Choose a Project to make its attached Vaults available to this Agent. Skills are
							installed separately.
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
					if (!open && !createdProjectAwaitingLink) setNewProjectName("");
				}}
			>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>Create project</DialogTitle>
						<DialogDescription>
							Create a Project and link it to this Agent. Add Skills and attach Vaults to the
							Project separately.
						</DialogDescription>
					</DialogHeader>
					{createdProjectAwaitingLink ? (
						<div className="space-y-4">
							<Alert variant="destructive">
								<AlertTitle>Project created, link not completed</AlertTitle>
								<AlertDescription>
									{displayProjectName(createdProjectAwaitingLink)} remains in your Project library.
									Retrying links that exact Project and will not create another one.
								</AlertDescription>
								{retryCreatedProjectLink.error || initialLinkError ? (
									<AlertDescription>
										{errorMessage(retryCreatedProjectLink.error ?? initialLinkError)}
									</AlertDescription>
								) : null}
							</Alert>
							<DialogFooter>
								<Button type="button" variant="ghost" onClick={() => setCreateOpen(false)}>
									Close
								</Button>
								<Button type="button" variant="outline" onClick={keepCreatedProjectUnlinked}>
									Keep unlinked
								</Button>
								<Button
									type="button"
									disabled={retryCreatedProjectLink.isPending}
									onClick={submitRetryLink}
								>
									{retryCreatedProjectLink.isPending ? <Spinner className="size-3.5" /> : <Link2 />}
									Retry link
								</Button>
							</DialogFooter>
						</div>
					) : (
						<form
							className="space-y-4"
							onSubmit={(event) => {
								event.preventDefault();
								submitCreateAndLink();
							}}
						>
							<div className="space-y-1.5">
								<Label htmlFor="agent-project-name">Project name</Label>
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
							<DialogFooter>
								<Button type="button" variant="ghost" onClick={() => setCreateOpen(false)}>
									Cancel
								</Button>
								<Button type="submit" disabled={!newProjectName.trim() || createAndLink.isPending}>
									{createAndLink.isPending ? <Spinner className="size-3.5" /> : <Plus />}
									Create project
								</Button>
							</DialogFooter>
						</form>
					)}
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
	const footer = [`Vault priority ${position + 1}`];
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
