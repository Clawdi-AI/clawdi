"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Home, Layers, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { DetailPanel } from "@/components/detail/layout";
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
export type AgentProjectBinding = components["schemas"]["AgentProjectBindingResponse"];

export function useAgentProjectBindings(
	agentId: string | null | undefined,
	{ enabled = true }: { enabled?: boolean } = {},
) {
	const api = useApi();
	return useQuery({
		queryKey: ["agent-project-bindings", agentId ?? ""],
		queryFn: async (): Promise<AgentProjectBinding[]> => {
			if (!agentId) throw new Error("Agent identity is not resolved");
			return unwrap(
				await api.GET("/v1/agents/{agent_id}/project-bindings", {
					params: { path: { agent_id: agentId } },
				}),
			);
		},
		enabled: enabled && Boolean(agentId),
	});
}

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
			isLoading={bindings.isLoading}
			bindingsError={bindings.error}
			onRetryBindings={() => {
				void bindings.refetch();
			}}
			projectsError={projects.error}
			onRetryProjects={() => {
				void projects.refetch();
			}}
			onChanged={() => {
				void queryClient.invalidateQueries({ queryKey: ["agent-project-bindings", agentId] });
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
	const primary = bindings.find((binding) => binding.binding_type === "primary") ?? null;
	const contexts = bindings
		.filter((binding) => binding.binding_type === "context")
		.sort((a, b) => a.priority - b.priority);
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

	if (isLoading) return <Skeleton className="h-40 w-full" />;

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
		<div className="space-y-4">
			<DetailPanel>
				<div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,420px)] lg:items-start">
					<div className="space-y-3">
						<div className="flex items-center gap-2">
							<Home className="size-4 text-muted-foreground" />
							<h2 className="text-sm font-semibold">Agent Project</h2>
						</div>
						<p className="text-xs text-muted-foreground">
							This Project is created with the agent and is always its writable default. It cannot
							be replaced, shared, or removed from here.
						</p>
						{primary ? (
							<ProjectUseLine binding={primary} project={projectsById.get(primary.project_id)} />
						) : (
							<EmptyState variant="inset" description="Agent Project is not loaded yet." />
						)}
					</div>
					<div className="rounded-md border bg-background/60 p-3 text-xs text-muted-foreground">
						Create Projects to share resources with teammates and across agents. This agent&apos;s
						main Project stays private to this agent; other agents cannot see it.
					</div>
				</div>
			</DetailPanel>

			<DetailPanel>
				<div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,420px)] lg:items-start">
					<div className="space-y-2">
						<div className="flex items-center gap-2">
							<Layers className="size-4 text-muted-foreground" />
							<h2 className="text-sm font-semibold">Added Projects</h2>
						</div>
						<p className="text-xs text-muted-foreground">
							Added Projects are read after the Agent Project. Use the list below to adjust read
							order after adding one.
						</p>
					</div>
					<div className="grid gap-3">
						<ProjectScopePicker
							projects={contextChoices}
							value={contextProjectId}
							onValueChange={setContextProjectId}
							label="Project to Add"
							placeholder="Choose a Project…"
							layout="stacked"
							disabled={contextChoices.length === 0}
						/>
						{contextChoices.length === 0 ? (
							<p className="text-xs text-muted-foreground">
								No Custom or shared Projects are available to add.
							</p>
						) : null}
						<Button
							size="sm"
							disabled={!contextProjectId || addContext.isPending}
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
				</div>
			</DetailPanel>

			<section className="space-y-2">
				<div className="flex items-center justify-between gap-2">
					<h2 className="text-sm font-semibold">Added Project Order</h2>
					<Badge variant="secondary">{contexts.length}</Badge>
				</div>
				{contexts.length === 0 ? (
					<EmptyState
						variant="inset"
						description="No added Projects yet. Add a Custom or shared Project to make it available to this agent."
					/>
				) : (
					<div className="divide-y rounded-lg border bg-card/60">
						{contexts.map((binding, index) => {
							const project = projectsById.get(binding.project_id);
							const projectName = project?.name || binding.project_id;
							const isRemoving = removeBinding.isPending && removeBinding.variables === binding.id;
							return (
								<div
									key={binding.id}
									className="grid gap-3 px-3 py-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center"
								>
									<div className="flex min-w-0 items-start gap-3">
										<div className="flex size-7 shrink-0 items-center justify-center rounded-md border bg-background text-xs font-medium">
											{index + 1}
										</div>
										<ProjectUseLine binding={binding} project={project} />
									</div>
									<div className="flex items-center justify-end gap-1">
										<Button
											variant="ghost"
											size="icon-sm"
											disabled={index === 0 || reorder.isPending}
											onClick={() => moveContext(binding.id, -1)}
											title="Move up"
											aria-label="Move project up"
										>
											<ArrowUp className="size-3.5" />
										</Button>
										<Button
											variant="ghost"
											size="icon-sm"
											disabled={index === contexts.length - 1 || reorder.isPending}
											onClick={() => moveContext(binding.id, 1)}
											title="Move down"
											aria-label="Move project down"
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
								</div>
							);
						})}
					</div>
				)}
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
	const bindingLabel = binding.binding_type === "primary" ? "Agent Project" : "Added";
	if (!project) {
		return (
			<div className="min-w-0">
				<div className="flex flex-wrap items-center gap-2">
					<span className="truncate text-sm font-medium">{binding.project_id}</span>
					<Badge variant={binding.binding_type === "primary" ? "secondary" : "outline"}>
						{bindingLabel}
					</Badge>
				</div>
				{binding.binding_type === "context" ? (
					<div className="mt-1 text-xs text-muted-foreground">Read order {binding.priority}</div>
				) : null}
			</div>
		);
	}
	return (
		<div className="min-w-0">
			<ProjectIdentity
				project={project}
				showKind={false}
				showAccess={false}
				badges={
					<Badge variant={binding.binding_type === "primary" ? "secondary" : "outline"}>
						{bindingLabel}
					</Badge>
				}
			/>
			{binding.binding_type === "context" ? (
				<div className="mt-0.5 text-xs text-muted-foreground">Read order {binding.priority}</div>
			) : null}
		</div>
	);
}
