"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
	Unplug,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useSetAgentBreadcrumbTitle } from "@/components/breadcrumb-title";
import {
	AgentSourceBadgeForEnvironment,
	agentDisplayName,
	agentTypeLabel,
	cleanMachineName,
} from "@/components/dashboard/agent-label";
import { AgentSettingsPanel } from "@/components/dashboard/agent-settings-panel";
import { DetailNotFound, DetailPanel, type DetailSectionMeta } from "@/components/detail/layout";
import {
	isCustomProject,
	isProjectOwner,
	ProjectIdentity,
	ProjectScopePicker,
} from "@/components/projects/project-metadata";
import { SessionFeed } from "@/components/sessions/session-feed";
import { SkillCardGrid } from "@/components/skills/skill-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
	type AgentSectionId,
	agentSectionHref,
	agentSectionLabel,
	agentSessionDetailHref,
	agentSkillDetailHref,
	CONNECTED_AGENT_SECTION_IDS,
} from "@/lib/agent-routes";
import { unwrap, useApi } from "@/lib/api";
import { fetchAllPages } from "@/lib/api-pagination";
import type { components } from "@/lib/api-schemas";
import { projectResourceHref } from "@/lib/project-resource-model";
import { sessionListQueryOptions } from "@/lib/session-queries";
import { errorMessage } from "@/lib/utils";

type SkillSummary = components["schemas"]["SkillSummaryResponse"];
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
}: {
	environmentId: string;
	section?: AgentSectionId;
}) {
	const id = environmentId;
	const router = useRouter();
	const api = useApi();
	const queryClient = useQueryClient();
	const searchParams = useSearchParams();
	const activeTab = parseAgentTab(section) ?? "overview";

	useEffect(() => {
		if (parseAgentTab(section)) return;
		router.replace(agentSectionHref(id, "overview", searchParams.toString()));
	}, [id, router, searchParams, section]);

	const {
		data: agent,
		isLoading,
		error,
	} = useQuery({
		queryKey: ["agent", id],
		queryFn: async () =>
			unwrap(
				await api.GET("/api/environments/{environment_id}", {
					params: { path: { environment_id: id } },
				}),
			),
	});

	const { data: projects } = useQuery({
		queryKey: ["projects"],
		queryFn: async (): Promise<ProjectRow[]> => unwrap(await api.GET("/api/projects")),
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

	const { data: projectBindings, isLoading: projectBindingsLoading } = useQuery({
		queryKey: ["agent-project-bindings", id],
		queryFn: async (): Promise<ProjectBindingRow[]> =>
			unwrap(
				await api.GET("/api/agents/{agent_id}/project-bindings", {
					params: { path: { agent_id: id } },
				}),
			),
		enabled: !!agent,
	});

	const { data: sessionsPage, isLoading: sessionsLoading } = useQuery({
		...sessionListQueryOptions(api, { environment_id: id, page_size: 50 }),
		enabled: !!agent,
	});

	// Skills section: fetch ONLY this env's project. The earlier
	// shape loaded the first 200 account-wide rows and filtered
	// client-side, which on a multi-agent account with >200
	// skills could miss this agent's rows entirely if they fell
	// past page 1 in the global sort. The `project_id` query
	// pushes the filter into the database so the per-page cap
	// applies within the agent's own inventory.
	//
	// Walk every page server-side: a single agent with >200
	// skills (rare but possible — power users with sprawling
	// skill libraries) would otherwise lose rows past the
	// page-1 cap. Same loop pattern the cross-agent /skills
	// page uses; hard cap at 50 pages = 10k skills as a
	// runaway-listing guard.
	const agentProjectId = agent?.default_project_id;
	const { data: skillsData, isLoading: skillsLoading } = useQuery({
		queryKey: ["skills", agentProjectId, "all-pages"],
		queryFn: async () =>
			fetchAllPages<SkillSummary>(
				async (page, pageSize) =>
					unwrap(
						await api.GET("/api/skills", {
							params: {
								query: {
									page,
									page_size: pageSize,
									project_id: agentProjectId,
								},
							},
						}),
					),
				{ pageSize: 200, resourceName: "agent skills" },
			),
		enabled: !!agentProjectId,
	});
	const skillsForThisEnv = useMemo(() => {
		// `?project_id=<agentProjectId>` narrows the listing to the
		// selected project. Row actions still resolve writability from
		// the shared project ownership map in `skill-columns`.
		if (!skillsData?.items || !agentProjectId) return undefined;
		return skillsData.items;
	}, [skillsData, agentProjectId]);

	const uninstallSkill = useMutation({
		mutationFn: async ({ skillKey, projectId }: { skillKey: string; projectId: string }) =>
			unwrap(
				await api.DELETE("/api/projects/{project_id}/skills/{skill_key}", {
					params: { path: { project_id: projectId, skill_key: skillKey } },
				}),
			),
		onSuccess: (_data, vars) => {
			toast.success("Skill uninstalled", {
				description: `${vars.skillKey} was removed from this agent. Other agents keep their copies.`,
			});
			queryClient.invalidateQueries({ queryKey: ["skills"] });
		},
		onError: (e) => toast.error("Couldn't uninstall skill", { description: errorMessage(e) }),
	});

	const sessionTotal = sessionsPage?.total ?? 0;
	const activeTabMeta = AGENT_DETAIL_NAV_META[activeTab];
	const activeTabLabel = agentSectionLabel(activeTab);
	const ActiveTabIcon = activeTabMeta.icon;
	const scopedSessionHref = (sessionId: string) => agentSessionDetailHref(id, sessionId);
	const scopedSkillHref = (skill: SkillSummary) =>
		agentSkillDetailHref(id, skill.skill_key, skill.project_id);

	const agentTitle = agent ? agentDisplayName(agent) : null;
	useSetAgentBreadcrumbTitle({ agentId: id, agentTitle, section: activeTab });

	const disconnect = useMutation({
		mutationFn: async () =>
			unwrap(
				await api.DELETE("/api/environments/{environment_id}", {
					params: { path: { environment_id: id } },
				}),
			),
		onSuccess: () => {
			toast.success("Agent disconnected", {
				description:
					sessionTotal > 0
						? `${sessionTotal} session${sessionTotal === 1 ? "" : "s"} kept (agent label dropped).`
						: undefined,
			});
			// Invalidate every query that may render this environment — the
			// dashboard agents card, sessions list (which joins agent labels),
			// and the per-agent session lookup. Use predicate-form so we catch
			// query keys with extra params like ["sessions", { page, q }].
			queryClient.invalidateQueries({
				predicate: (q) => {
					const k = q.queryKey[0];
					return k === "environments" || k === "sessions" || k === "agent";
				},
			});
			router.push("/");
		},
		onError: (e) => toast.error("Couldn't disconnect agent", { description: errorMessage(e) }),
	});

	const onDisconnect = () => {
		disconnect.mutate();
	};

	return (
		<div className="space-y-6 px-4 lg:px-6">
			{error ? (
				<DetailNotFound title="Agent not found" message={errorMessage(error)} />
			) : isLoading ? (
				<div className="space-y-3 py-2">
					<Skeleton className="h-6 w-48" />
					<Skeleton className="h-4 w-64" />
				</div>
			) : agent ? (
				<>
					<h1 className="sr-only">
						{cleanMachineName(agent.machine_name) || agentTypeLabel(agent.agent_type)}
					</h1>

					<section className="space-y-4">
						<div className="flex flex-wrap items-start justify-between gap-3">
							<div>
								<div className="flex items-center gap-2">
									{ActiveTabIcon ? (
										<ActiveTabIcon className="size-4 text-muted-foreground" />
									) : null}
									<h2 className="text-xl font-semibold tracking-tight">{activeTabLabel}</h2>
									<AgentSourceBadgeForEnvironment env={agent} compact />
								</div>
								{activeTabMeta.description ? (
									<p className="mt-1 text-sm text-muted-foreground">{activeTabMeta.description}</p>
								) : null}
							</div>
							<div className="flex flex-wrap items-center gap-2">
								{activeTab === "skills" ? (
									<Button asChild variant="outline" size="sm">
										<Link
											href={`${projectResourceHref("skills")}?target=${encodeURIComponent(id)}`}
										>
											<Plus />
											Install skills
										</Link>
									</Button>
								) : null}
								<ConfirmAction
									title="Disconnect this agent?"
									description={
										<>
											<p>Sessions and skills stay in your account.</p>
											<p>
												This agent will stop syncing and sessions will no longer be tagged with it.
												Reconnect from that agent to resume.
											</p>
										</>
									}
									confirmLabel="Disconnect agent"
									onConfirm={onDisconnect}
								>
									<Button
										variant="outline"
										size="sm"
										disabled={disconnect.isPending}
										className="shrink-0"
									>
										<Unplug className="text-warning" />
										Disconnect
									</Button>
								</ConfirmAction>
							</div>
						</div>

						{activeTab === "overview" ? (
							<div className="grid gap-3 sm:grid-cols-3">
								<AgentStatPanel label="Sessions" value={sessionTotal} />
								<AgentStatPanel
									label="Skills"
									value={skillsForThisEnv ? skillsForThisEnv.length : "—"}
								/>
								<AgentStatPanel label="Projects" value={projectBindings?.length ?? "—"} />
							</div>
						) : null}

						{activeTab === "overview" ? (
							<div className="max-w-4xl">
								<SessionFeed
									sessions={(sessionsPage?.items ?? []).slice(0, 5)}
									isLoading={sessionsLoading}
									emptyMessage="No sessions synced from this agent yet."
									showAgent={false}
									sessionHref={(session) => scopedSessionHref(session.id)}
								/>
							</div>
						) : null}

						{activeTab === "sessions" ? (
							<div className="max-w-4xl">
								<SessionFeed
									sessions={sessionsPage?.items ?? []}
									isLoading={sessionsLoading}
									emptyMessage="No sessions synced from this agent yet."
									showAgent={false}
									sessionHref={(session) => scopedSessionHref(session.id)}
								/>
							</div>
						) : null}

						{activeTab === "skills" ? (
							<SkillCardGrid
								skills={skillsForThisEnv ?? []}
								isLoading={skillsLoading}
								emptyMessage="No skills installed on this agent yet."
								readOnlySkillCheck={(s) =>
									!s.project_id || !(writableProjectIds?.has(s.project_id) ?? false)
								}
								onUninstall={(skillKey, projectId) =>
									uninstallSkill.mutate({ skillKey, projectId })
								}
								uninstallPending={uninstallSkill.isPending}
								skillHref={scopedSkillHref}
							/>
						) : null}

						{activeTab === "projects" ? (
							<AgentProjectsPanel
								agentId={id}
								bindings={projectBindings ?? []}
								projects={projects ?? []}
								isLoading={projectBindingsLoading}
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
				</>
			) : null}
		</div>
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
	onChanged,
}: {
	agentId: string;
	bindings: ProjectBindingRow[];
	projects: ProjectRow[];
	isLoading: boolean;
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
				await api.POST("/api/agents/{agent_id}/project-bindings/context", {
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
		onError: (e) => toast.error("Couldn't add project", { description: errorMessage(e) }),
	});

	const removeBinding = useMutation({
		mutationFn: async (bindingId: string) => {
			await unwrap(
				await api.DELETE("/api/agents/{agent_id}/project-bindings/{binding_id}", {
					params: { path: { agent_id: agentId, binding_id: bindingId } },
				}),
			);
		},
		onSuccess: () => {
			onChanged();
			toast.success("Project removed");
		},
		onError: (e) => toast.error("Couldn't remove project", { description: errorMessage(e) }),
	});

	const reorder = useMutation({
		mutationFn: async (items: Array<{ binding_id: string; priority: number }>) => {
			await unwrap(
				await api.PATCH("/api/agents/{agent_id}/project-bindings/context/reorder", {
					params: { path: { agent_id: agentId } },
					body: { items },
				}),
			);
		},
		onSuccess: () => {
			onChanged();
			toast.success("Project order updated");
		},
		onError: (e) => toast.error("Couldn't reorder projects", { description: errorMessage(e) }),
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
							<div className="rounded-md border border-dashed px-3 py-4 text-sm text-muted-foreground">
								Agent Project is not loaded yet.
							</div>
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
					<div className="rounded-lg border border-dashed px-4 py-6 text-sm text-muted-foreground">
						No added Projects yet. Add a Custom or shared Project to make it available to this
						agent.
					</div>
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
