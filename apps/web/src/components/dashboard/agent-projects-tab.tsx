"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import {
	isCustomProject,
	ProjectIdentity,
	ProjectScopePicker,
} from "@/components/projects/project-metadata";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { toastApiError, unwrap, useApi } from "@/lib/api";
import type { components } from "@/lib/api-schemas";

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
			<div className="space-y-3" data-testid="agent-projects-loading">
				<Skeleton className="h-4 w-96 max-w-full" />
				<Skeleton className="h-52 w-full rounded-lg" />
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
			<section className="overflow-hidden rounded-lg border bg-card/60">
				{effectiveBindings.length === 0 ? (
					<EmptyState
						variant="inset"
						className="rounded-none border-0"
						description="The Agent Project is not available yet."
					/>
				) : (
					<ol className="divide-y" aria-label="Effective Project read order">
						{effectiveBindings.map((binding, position) => {
							const project = projectsById.get(binding.project_id);
							const projectName = project?.name || binding.project_id;
							const isRemoving = removeBinding.isPending && removeBinding.variables === binding.id;
							const contextIndex = binding.binding_type === "context" ? position - 1 : -1;
							return (
								<li
									key={binding.id}
									className="grid gap-3 px-3 py-3 sm:px-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center"
									data-binding-type={binding.binding_type}
								>
									<div className="flex min-w-0 items-start gap-3">
										<div className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-background text-xs font-semibold tabular-nums">
											<span className="sr-only">Position </span>
											{position + 1}
										</div>
										<ProjectUseLine binding={binding} project={project} />
									</div>
									{binding.binding_type === "context" ? (
										<div className="flex items-center justify-end gap-1">
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
									) : null}
								</li>
							);
						})}
					</ol>
				)}

				<div
					className="grid gap-3 border-t bg-background/40 p-3 sm:p-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-end"
					data-testid="agent-project-add"
				>
					<div className="space-y-2">
						<ProjectScopePicker
							projects={contextChoices}
							value={contextProjectId}
							onValueChange={setContextProjectId}
							label="Add a Project"
							placeholder="Choose a Custom or shared Project…"
							layout="stacked"
							disabled={!primary || contextChoices.length === 0}
						/>
						{contextChoices.length === 0 ? (
							<p className="text-xs text-muted-foreground">
								No Custom or shared Projects are available to add.
							</p>
						) : null}
					</div>
					<Button
						size="sm"
						disabled={!primary || !contextProjectId || addContext.isPending}
						variant={contextProjectId ? "default" : "outline"}
						onClick={() => addContext.mutate()}
					>
						{addContext.isPending ? (
							<Spinner className="size-3.5" />
						) : (
							<Plus className="size-3.5" />
						)}
						Add Project
					</Button>
				</div>
			</section>
		</div>
	);
}

function ProjectUseLine({
	binding,
	project,
}: {
	binding: AgentProjectBinding;
	project: ProjectRow | undefined;
}) {
	const bindingLabel = binding.binding_type === "primary" ? "Primary" : "Added";
	const resourceAccess =
		binding.binding_type === "primary"
			? "Default writes · Reads Skills and Vaults"
			: "Read access · Skills and Vaults";
	if (!project) {
		return (
			<div className="min-w-0">
				<div className="flex flex-wrap items-center gap-2">
					<span className="truncate text-sm font-medium">{binding.project_id}</span>
					<Badge variant={binding.binding_type === "primary" ? "secondary" : "outline"}>
						{bindingLabel}
					</Badge>
					<Badge variant="outline">Access unavailable</Badge>
				</div>
				<div className="mt-1 text-xs text-muted-foreground">{resourceAccess}</div>
			</div>
		);
	}
	return (
		<div className="min-w-0">
			<ProjectIdentity
				project={project}
				badges={
					<>
						<Badge variant={binding.binding_type === "primary" ? "secondary" : "outline"}>
							{bindingLabel}
						</Badge>
						{binding.binding_type === "primary" ? <Badge variant="outline">Fixed</Badge> : null}
					</>
				}
			/>
			<div className="mt-0.5 text-xs text-muted-foreground">{resourceAccess}</div>
		</div>
	);
}
