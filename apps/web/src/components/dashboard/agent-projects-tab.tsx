"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, FolderKanban, Plus, Trash2 } from "lucide-react";
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
import { HERO_CARD_BASE, HERO_GRID_CLASS, HeroCard } from "@/components/entity-card";
import { IconChip } from "@/components/icon-chip";
import { ListToolbar } from "@/components/list-toolbar";
import {
	displayProjectName,
	isCustomProject,
	isProjectOwner,
	ProjectCompactPicker,
	ProjectKindBadge,
	projectAlias,
} from "@/components/projects/project-metadata";
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
import { toastApiError, unwrap, useApi } from "@/lib/api";
import type { components } from "@/lib/api-schemas";
import { identityFor } from "@/lib/identity";

type ProjectRow = components["schemas"]["ProjectResponse"];

export function AgentProjectsTab({
	agentId,
	enabled = true,
}: {
	agentId: string;
	enabled?: boolean;
}) {
	const api = useApi();
	const queryClient = useQueryClient();
	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: async (): Promise<ProjectRow[]> => unwrap(await api.GET("/v1/projects")),
		enabled,
	});
	const bindings = useAgentProjectBindings(agentId, { enabled });

	return (
		<AgentProjectsPanel
			agentId={agentId}
			bindings={bindings.data ?? []}
			projects={projects.data ?? []}
			isLoading={bindings.isLoading || projects.isLoading}
			bindingsError={bindings.error}
			onRetryBindings={() => {
				void bindings.refetch();
			}}
			projectsError={projects.error}
			onRetryProjects={() => {
				void projects.refetch();
			}}
			onChanged={() => {
				void queryClient.invalidateQueries({ queryKey: agentProjectBindingsQueryKey(agentId) });
				void queryClient.invalidateQueries({ queryKey: ["projects"] });
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
	onChanged: () => void;
}) {
	const api = useApi();
	const [contextProjectId, setContextProjectId] = useState("");
	const [addOpen, setAddOpen] = useState(false);
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
			toast.success("Project added");
		},
		onError: toastApiError("Couldn't add project"),
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
						<div key={index} className={`${HERO_CARD_BASE} flex min-h-36 flex-col gap-3`}>
							<Skeleton className="size-10 rounded-lg" />
							<Skeleton className="h-4 w-36 max-w-full" />
							<Skeleton className="h-3 w-28 max-w-full" />
							<Skeleton className="mt-auto h-3 w-40 max-w-full" />
						</div>
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
					<Button
						size="sm"
						disabled={!primary}
						onClick={() => {
							setContextProjectId("");
							setAddOpen(true);
						}}
					>
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
				onOpenChange={(open) => {
					setAddOpen(open);
					if (!open) setContextProjectId("");
				}}
			>
				<DialogContent className="sm:max-w-md" data-testid="agent-project-add-dialog">
					<DialogHeader>
						<DialogTitle>Add Project</DialogTitle>
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
							<Button type="button" variant="ghost" onClick={() => setAddOpen(false)}>
								Cancel
							</Button>
							<Button type="submit" disabled={!contextProjectId || addContext.isPending}>
								{addContext.isPending ? (
									<Spinner className="size-3.5" />
								) : (
									<Plus className="size-3.5" />
								)}
								Add Project
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
	actions,
}: {
	binding: AgentProjectBinding;
	project: ProjectRow | undefined;
	position: number;
	actions?: React.ReactNode;
}) {
	const footer = [
		`Read order ${position + 1}`,
		binding.binding_type === "primary" ? "Default write destination" : null,
	];
	if (!project) {
		return (
			<HeroCard
				icon={
					<IconChip tint="bg-muted text-muted-foreground">
						<FolderKanban />
					</IconChip>
				}
				title={binding.project_id}
				badges={<Badge variant="outline">Access unavailable</Badge>}
				footer={footer}
				actions={actions}
			/>
		);
	}
	const projectName = displayProjectName(project);
	const identity = identityFor(projectName);
	return (
		<HeroCard
			icon={
				<IconChip tint={identity.colorClasses} className="text-xl">
					{identity.emoji}
				</IconChip>
			}
			title={projectName}
			badges={
				<>
					<ProjectKindBadge kind={project.kind ?? "workspace"} />
					{isProjectOwner(project) ? null : <Badge variant="outline">Viewer</Badge>}
				</>
			}
			description={projectAlias(project)}
			descriptionClassName="truncate font-mono"
			footer={footer}
			actions={actions}
		/>
	);
}
