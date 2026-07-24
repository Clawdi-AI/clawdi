"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useRouter } from "@tanstack/react-router";
import {
	ArrowDown,
	ArrowUp,
	Home,
	Layers,
	MessageSquare,
	Plus,
	Settings,
	Sparkles,
	Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { useSetAgentBreadcrumbTitle } from "@/components/breadcrumb-title";
import {
	AgentSourceBadgeForEnvironment,
	agentDisplayName,
} from "@/components/dashboard/agent-label";
import { AgentSettingsPanel } from "@/components/dashboard/agent-settings-panel";
import { AgentSkillsTab, useAgentProjectSkills } from "@/components/dashboard/agent-skills-tab";
import { DetailNotFound, DetailPanel, type DetailSectionMeta } from "@/components/detail/layout";
import { EmptyState } from "@/components/empty-state";
import { ENTITY_CARD_BASE } from "@/components/entity-card";
import { PageHeader } from "@/components/page-header";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import {
	isCustomProject,
	isProjectOwner,
	ProjectIdentity,
	ProjectScopePicker,
} from "@/components/projects/project-metadata";
import { SessionFeed } from "@/components/sessions/session-feed";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { agentOwnershipKindFromId, useAgentOwnership } from "@/lib/agent-ownership";
import {
	type AgentSectionId,
	agentSectionHref,
	agentSectionLabel,
	CONNECTED_AGENT_SECTION_IDS,
} from "@/lib/agent-routes";
import { toastApiError, unwrap, useApi } from "@/lib/api";
import { isApiNotFoundError } from "@/lib/api-errors";
import type { components } from "@/lib/api-schemas";
import { sessionListQueryOptions } from "@/lib/session-queries";
import { cn, errorMessage } from "@/lib/utils";

type AgentTab = "overview" | "sessions" | "skills" | "projects" | "settings";

type ProjectRow = components["schemas"]["ProjectResponse"];
type ProjectBindingRow = components["schemas"]["AgentProjectBindingResponse"];

const AGENT_DETAIL_NAV_META: Record<AgentTab, DetailSectionMeta> = {
	overview: {
		icon: Home,
		description: "Status, inventory, and recent activity for this agent.",
	},
	sessions: {
		icon: MessageSquare,
		description: "History synced by this agent.",
	},
	skills: {
		icon: Sparkles,
		description: "Installed in this agent's Agent Project.",
	},
	projects: {
		icon: Layers,
		description: "Agent Project, added Projects, and read order.",
	},
	settings: {
		icon: Settings,
		description: "Name and avatar used across the dashboard.",
	},
};

export function ConnectedAgentDetail({
	environmentId,
	section = "overview",
	showSourceBadge = true,
}: {
	environmentId: string;
	section?: AgentSectionId;
	showSourceBadge?: boolean;
}) {
	const id = environmentId;
	const router = useRouter();
	const api = useApi();
	const queryClient = useQueryClient();
	const ownership = useAgentOwnership();
	const searchStr = useLocation({ select: (location) => location.searchStr });
	const activeTab = parseAgentTab(section) ?? "overview";

	useEffect(() => {
		if (parseAgentTab(section)) return;
		void router.navigate({ href: agentSectionHref(id, "overview", searchStr), replace: true });
	}, [id, router, searchStr, section]);

	const {
		data: agent,
		isLoading,
		error,
		refetch: refetchAgent,
	} = useQuery({
		queryKey: ["agents", id],
		queryFn: async () =>
			unwrap(
				await api.GET("/v1/agents/{agent_id}", {
					params: { path: { agent_id: id } },
				}),
			),
	});

	const {
		data: projects,
		error: projectsError,
		refetch: refetchProjects,
	} = useQuery({
		queryKey: ["projects"],
		queryFn: async (): Promise<ProjectRow[]> => unwrap(await api.GET("/v1/projects")),
		enabled: !!agent,
	});
	const writableProjectIds = useMemo(
		() =>
			projects
				? new Set(
						projects.filter((project) => isProjectOwner(project)).map((project) => project.id),
					)
				: null,
		[projects],
	);

	const {
		data: projectBindings,
		isLoading: projectBindingsLoading,
		error: projectBindingsError,
		refetch: refetchProjectBindings,
	} = useQuery({
		queryKey: ["agent-project-bindings", id],
		queryFn: async (): Promise<ProjectBindingRow[]> =>
			unwrap(
				await api.GET("/v1/agents/{agent_id}/project-bindings", {
					params: { path: { agent_id: id } },
				}),
			),
		enabled: !!agent,
	});

	const {
		data: sessionsPage,
		isLoading: sessionsLoading,
		error: sessionsError,
		refetch: refetchSessions,
	} = useQuery({
		...sessionListQueryOptions(api, { environment_id: id, page_size: 50 }),
		enabled: !!agent,
	});

	const agentProjectId = agent?.default_project_id;
	const {
		skills: skillsForThisEnv,
		error: skillsError,
		refetch: refetchSkills,
	} = useAgentProjectSkills(agentProjectId);

	const sessionTotal = sessionsError ? "—" : (sessionsPage?.total ?? 0);
	const activeTabMeta = AGENT_DETAIL_NAV_META[activeTab];
	const activeTabLabel = agentSectionLabel(activeTab);
	const ActiveTabIcon = activeTabMeta.icon;
	const ownershipKind = agent ? agentOwnershipKindFromId(agent.id, ownership) : "connected";
	const agentTitle = agent ? agentDisplayName(agent) : null;
	useSetAgentBreadcrumbTitle({ agentId: id, agentTitle, section: activeTab });
	const headerStatus =
		agent && showSourceBadge ? (
			<AgentSourceBadgeForEnvironment env={agent} ownershipKind={ownershipKind} compact />
		) : null;
	const headerActions =
		activeTab === "skills" ? (
			<Button
				render={<Link to="/skills" search={{ target: id }} />}
				nativeButton={false}
				variant="outline"
				size="sm"
			>
				<Plus />
				Install skills
			</Button>
		) : null;
	const scopedSessionLink = (sessionId: string) => ({
		to: "/agents/$id/sessions/$sessionId" as const,
		params: { id, sessionId },
	});
	return (
		<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, "flex flex-col gap-6 px-4 lg:px-6")}>
			{error ? (
				isApiNotFoundError(error) ? (
					<DetailNotFound title="Agent not found" message={errorMessage(error)} />
				) : (
					<ApiErrorPanel
						error={error}
						onRetry={() => {
							void refetchAgent();
						}}
						title="Couldn't load agent"
					/>
				)
			) : isLoading ? (
				<AgentDetailContentSkeleton />
			) : agent ? (
				<section className="flex flex-col gap-4">
					<PageHeader
						title={activeTabLabel}
						description={activeTabMeta.description}
						icon={ActiveTabIcon ? <ActiveTabIcon className="size-4 text-muted-foreground" /> : null}
						status={headerStatus}
						actions={headerActions}
					/>

					{activeTab === "overview" ? (
						<div className="flex flex-col gap-4">
							<div className="grid gap-3 sm:grid-cols-3">
								<AgentStatPanel label="Sessions" value={sessionTotal} />
								<AgentStatPanel
									label="Skills"
									value={skillsError ? "—" : skillsForThisEnv ? skillsForThisEnv.length : "—"}
								/>
								<AgentStatPanel
									label="Projects"
									value={projectBindingsError ? "—" : (projectBindings?.length ?? "—")}
								/>
							</div>
							{skillsError ? (
								<ApiErrorPanel
									error={skillsError}
									onRetry={() => {
										void refetchSkills();
									}}
									title="Couldn't load agent skills"
								/>
							) : null}
							{projectBindingsError ? (
								<ApiErrorPanel
									error={projectBindingsError}
									onRetry={() => {
										void refetchProjectBindings();
									}}
									title="Couldn't load agent Projects"
								/>
							) : null}
							{sessionsError ? (
								<ApiErrorPanel
									error={sessionsError}
									onRetry={() => {
										void refetchSessions();
									}}
									title="Couldn't load agent sessions"
								/>
							) : (
								<SessionFeed
									sessions={(sessionsPage?.items ?? []).slice(0, 5)}
									isLoading={sessionsLoading}
									emptyMessage="No sessions synced from this agent yet."
									emptyVariant="inset"
									showAgent={false}
									sessionLink={(session) => scopedSessionLink(session.id)}
								/>
							)}
						</div>
					) : null}

					{activeTab === "sessions" ? (
						sessionsError ? (
							<ApiErrorPanel
								error={sessionsError}
								onRetry={() => {
									void refetchSessions();
								}}
								title="Couldn't load agent sessions"
							/>
						) : (
							<SessionFeed
								sessions={sessionsPage?.items ?? []}
								isLoading={sessionsLoading}
								emptyMessage="No sessions synced from this agent yet."
								showAgent={false}
								sessionLink={(session) => scopedSessionLink(session.id)}
							/>
						)
					) : null}

					{activeTab === "skills" ? (
						<AgentSkillsTab
							agentId={id}
							agentProjectId={agentProjectId}
							writableProjectIds={writableProjectIds}
						/>
					) : null}

					{activeTab === "projects" ? (
						<AgentProjectsPanel
							agentId={id}
							bindings={projectBindings ?? []}
							projects={projects ?? []}
							isLoading={projectBindingsLoading}
							bindingsError={projectBindingsError}
							onRetryBindings={() => {
								void refetchProjectBindings();
							}}
							projectsError={projectsError}
							onRetryProjects={() => {
								void refetchProjects();
							}}
							onChanged={() => {
								queryClient.invalidateQueries({
									queryKey: ["agent-project-bindings", id],
								});
								queryClient.invalidateQueries({ queryKey: ["projects"] });
							}}
						/>
					) : null}

					{activeTab === "settings" ? <AgentSettingsPanel environmentId={id} /> : null}
				</section>
			) : null}
		</div>
	);
}

export function ConnectedAgentDetailSkeleton({ hosted = false }: { hosted?: boolean }) {
	return (
		<div
			data-hosted={hosted ? "true" : undefined}
			className={cn(CENTERED_PAGE_WIDTH_CLASS.page, "flex flex-col gap-6 px-4 lg:px-6")}
		>
			<AgentDetailContentSkeleton />
		</div>
	);
}

function AgentDetailContentSkeleton() {
	return (
		<section className="flex flex-col gap-4">
			<div className="flex flex-col gap-2">
				<div className="flex items-center gap-2">
					<Skeleton className="size-4 rounded-sm" />
					<Skeleton className="h-5 w-28" />
				</div>
				<Skeleton className="h-4 w-80 max-w-full" />
			</div>
			<div className="grid gap-3 sm:grid-cols-3">
				{Array.from({ length: 3 }).map((_, index) => (
					<DetailPanel key={index} className="p-3">
						<Skeleton className="h-7 w-12" />
						<Skeleton className="mt-1.5 h-3 w-16" />
					</DetailPanel>
				))}
			</div>
			<div className="flex flex-col gap-2">
				{Array.from({ length: 3 }).map((_, index) => (
					<div key={index} className={cn(ENTITY_CARD_BASE, "flex items-start gap-3")}>
						<Skeleton className="size-8 shrink-0 rounded-md" />
						<div className="min-w-0 flex-1">
							<Skeleton className="h-4 w-4/5" />
							<Skeleton className="mt-3 h-3 w-1/2" />
						</div>
					</div>
				))}
			</div>
		</section>
	);
}

function parseAgentTab(value: AgentSectionId | string | null): AgentTab | null {
	if (value === "overview") return "overview";
	if (CONNECTED_AGENT_SECTION_IDS.includes(value as AgentTab)) return value as AgentTab;
	return null;
}

function AgentStatPanel({ label, value }: { label: string; value: React.ReactNode }) {
	return (
		<DetailPanel className="p-3">
			<div className="text-xl font-semibold tabular-nums">{value}</div>
			<div className="text-xs text-muted-foreground">{label}</div>
		</DetailPanel>
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
	bindings: ProjectBindingRow[];
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
						<ProjectSelect
							value={contextProjectId}
							onValueChange={setContextProjectId}
							projects={contextChoices}
							label="Project to Add"
							placeholder="Choose a Project…"
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

function ProjectSelect({
	value,
	onValueChange,
	projects,
	label,
	placeholder,
}: {
	value: string;
	onValueChange: (value: string) => void;
	projects: ProjectRow[];
	label: string;
	placeholder: string;
}) {
	return (
		<ProjectScopePicker
			projects={projects}
			value={value}
			onValueChange={onValueChange}
			label={label}
			placeholder={placeholder}
			layout="stacked"
			disabled={projects.length === 0}
		/>
	);
}

function ProjectUseLine({
	binding,
	project,
}: {
	binding: ProjectBindingRow;
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
