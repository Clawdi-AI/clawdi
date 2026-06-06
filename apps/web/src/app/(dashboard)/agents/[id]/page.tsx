"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	ArrowDown,
	ArrowUp,
	Brain,
	Home,
	Layers,
	MessageSquare,
	Plus,
	Sparkles,
	Trash2,
	Unplug,
} from "lucide-react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useSetBreadcrumbTitle } from "@/components/breadcrumb-title";
import { AgentLabel, agentTypeLabel, cleanMachineName } from "@/components/dashboard/agent-label";
import { DaemonStatusBadge } from "@/components/dashboard/daemon-status";
import { DetailNotFound, DetailPanel } from "@/components/detail/layout";
import { MemoryRelationshipList } from "@/components/memories/memory-relationship-list";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { unwrap, useApi, useAuthedFetch } from "@/lib/api";
import { fetchAllPages } from "@/lib/api-pagination";
import type { components } from "@/lib/api-schemas";
import { projectResourceHref } from "@/lib/project-resource-model";
import { errorMessage, relativeTime } from "@/lib/utils";

type SkillSummary = components["schemas"]["SkillSummaryResponse"];
type AgentTab = "sessions" | "memories" | "skills" | "projects";

interface ProjectRow {
	id: string;
	name: string;
	slug: string;
	kind: string;
	is_owner?: boolean;
	owner_display?: string | null;
	owner_handle?: string | null;
}

interface ProjectBindingRow {
	id: string;
	agent_id: string;
	project_id: string;
	binding_type: "primary" | "context";
	priority: number;
	default_write_enabled: boolean;
	created_at: string;
}

export default function AgentDetailPage() {
	const { id } = useParams<{ id: string }>();
	const router = useRouter();
	const api = useApi();
	const authedFetch = useAuthedFetch();
	const queryClient = useQueryClient();
	// Hosted tiles navigate here with `?source=on-clawdi` so the sync
	// badge can render hosted-aware remediation copy (no CLI snippets,
	// pointer to the Clawdi dashboard for lifecycle ops). Self-managed
	// callers omit the param and the badge falls back to its default
	// "self-managed" behavior — same shape as the overview-grid badge.
	const searchParams = useSearchParams();
	const badgeSource = searchParams.get("source") === "on-clawdi" ? "on-clawdi" : "self-managed";
	const requestedTab = parseAgentTab(searchParams.get("tab")) ?? "sessions";

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
		// Daemon liveness (online/errored/offline badge) is computed
		// from `last_sync_at`. Without polling, a daemon dying
		// while the user is on this page would never paint red —
		// they'd think the daemon was fine until they navigate
		// away and back. 10s matches the heartbeat-cadence ÷ 3,
		// so the badge transitions within ~one missed beat.
		refetchInterval: 10_000,
	});

	const { data: projects } = useQuery({
		queryKey: ["projects"],
		queryFn: async (): Promise<ProjectRow[]> => {
			const r = await authedFetch("/api/projects");
			return r.json();
		},
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
		queryFn: async (): Promise<ProjectBindingRow[]> => {
			const r = await authedFetch(`/api/agents/${id}/project-bindings`);
			return r.json();
		},
		enabled: !!agent,
	});

	const { data: sessionsPage, isLoading: sessionsLoading } = useQuery({
		queryKey: ["agent-sessions", id],
		queryFn: async () =>
			unwrap(
				await api.GET("/api/sessions", {
					params: { query: { environment_id: id, page_size: 50 } },
				}),
			),
		enabled: !!agent,
	});

	const { data: memoriesPage, isLoading: memoriesLoading } = useQuery({
		queryKey: ["agent-memories", id],
		queryFn: async () =>
			unwrap(
				await api.GET("/api/memories", {
					params: {
						query: {
							environment_id: id,
							page_size: 50,
						},
					},
				}),
			),
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

	// Controlled tab state so the row-level "Install skills" button can
	// render only on the Skills tab — keeping the action contextual to
	// what the user is looking at, instead of floating an Install CTA
	// over a Sessions list it has nothing to do with.
	const [activeTab, setActiveTab] = useState<AgentTab>(requestedTab);
	const activeTabMeta =
		activeTab === "skills"
			? {
					icon: Sparkles,
					title: "Installed skills",
					description:
						"Skills installed in this agent's Agent Project. They apply whenever this agent runs.",
				}
			: activeTab === "projects"
				? {
						icon: Layers,
						title: "Project access",
						description:
							"The Agent Project is fixed. Added Custom or shared Projects add read-only context.",
					}
				: activeTab === "memories"
					? {
							icon: Brain,
							title: "Learned memories",
							description: "Account-level memories generated from this agent's sessions.",
						}
					: {
							icon: MessageSquare,
							title: "Session history",
							description: "Review sessions synced by this agent.",
						};

	useEffect(() => {
		setActiveTab(requestedTab);
	}, [requestedTab]);

	const setTab = (tab: AgentTab) => {
		setActiveTab(tab);
		const next = new URLSearchParams(searchParams.toString());
		if (tab === "sessions") next.delete("tab");
		else next.set("tab", tab);
		const query = next.toString();
		router.replace(query ? `/agents/${id}?${query}` : `/agents/${id}`, { scroll: false });
	};

	// Wait until `agent` is loaded — otherwise `agentTypeLabel(undefined)`
	// returns the literal "Unknown", which would briefly flash in the
	// breadcrumb during the initial query.
	useSetBreadcrumbTitle(
		agent ? cleanMachineName(agent.machine_name) || agentTypeLabel(agent.agent_type) : null,
	);

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
		<div className="space-y-5 px-4 lg:px-6">
			{error ? (
				<DetailNotFound title="Agent not found" message={errorMessage(error)} />
			) : isLoading ? (
				<div className="space-y-3 py-2">
					<Skeleton className="h-6 w-48" />
					<Skeleton className="h-4 w-64" />
				</div>
			) : agent ? (
				<>
					{/* Same AgentLabel pattern as the overview tile, just
					    bumped to size="xl". Two visual rows: title +
					    flex-wrap subtitle (agent_type, version, os,
					    last seen, sync badge). Icon vertically centers
					    against the text block — items-center. */}
					<h1 className="sr-only">
						{cleanMachineName(agent.machine_name) || agentTypeLabel(agent.agent_type)}
					</h1>
					<div className="flex items-center justify-between gap-4">
						<AgentLabel
							machineName={agent.machine_name}
							type={agent.agent_type}
							size="xl"
							primary="machine"
							meta={[
								agent.agent_version ? `v${agent.agent_version}` : null,
								agent.os,
								agent.last_seen_at ? `last seen ${relativeTime(agent.last_seen_at)}` : null,
								<DaemonStatusBadge env={agent} source={badgeSource} />,
							]}
							className="min-w-0 flex-1"
						/>
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

					<Tabs value={activeTab} onValueChange={(v) => setTab(parseAgentTab(v) ?? "sessions")}>
						{/* Flat tab chrome — no boxed section wrappers (taste audit #1). */}
						<div className="flex flex-wrap items-end justify-between gap-2">
							<TabsList className="grid w-full grid-cols-4 sm:w-fit">
								<TabsTrigger value="sessions" className="min-w-0 px-2">
									Sessions
									<span className="ml-1.5 text-xs text-muted-foreground tabular-nums">
										{sessionTotal}
									</span>
								</TabsTrigger>
								<TabsTrigger value="memories" className="min-w-0 px-2">
									Memories
									{memoriesPage ? (
										<span className="ml-1.5 text-xs text-muted-foreground tabular-nums">
											{memoriesPage.total}
										</span>
									) : null}
								</TabsTrigger>
								<TabsTrigger value="skills" className="min-w-0 px-2">
									Skills
									{skillsForThisEnv ? (
										<span className="ml-1.5 text-xs text-muted-foreground tabular-nums">
											{skillsForThisEnv.length}
										</span>
									) : null}
								</TabsTrigger>
								<TabsTrigger value="projects" className="min-w-0 px-2">
									Projects
									{projectBindings ? (
										<span className="ml-1.5 text-xs text-muted-foreground tabular-nums">
											{projectBindings.length}
										</span>
									) : null}
								</TabsTrigger>
							</TabsList>
							{activeTab === "skills" ? (
								<Button asChild variant="outline" size="sm">
									<Link href={`${projectResourceHref("skills")}?target=${encodeURIComponent(id)}`}>
										<Plus />
										Install skills
									</Link>
								</Button>
							) : null}
						</div>
						<p className="mt-2 text-xs text-muted-foreground">{activeTabMeta.description}</p>

						<div className="mt-4">
							<TabsContent value="sessions" className="m-0">
								{/* This page IS the agent — the feed drops the redundant
								    per-row agent column the old table repeated 25 times. */}
								<div className="max-w-4xl">
									<SessionFeed
										sessions={sessionsPage?.items ?? []}
										isLoading={sessionsLoading}
										emptyMessage="No sessions synced from this agent yet."
										showAgent={false}
									/>
								</div>
							</TabsContent>

							<TabsContent value="memories" className="m-0">
								<div className="max-w-4xl">
									<MemoryRelationshipList
										memories={memoriesPage?.items ?? []}
										isLoading={memoriesLoading}
										emptyMessage="No memories have been linked to this agent yet."
									/>
								</div>
							</TabsContent>

							<TabsContent value="skills" className="m-0">
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
								/>
							</TabsContent>

							<TabsContent value="projects" className="m-0">
								<AgentProjectsPanel
									agentId={id}
									bindings={projectBindings ?? []}
									projects={projects ?? []}
									isLoading={projectBindingsLoading}
									authedFetch={authedFetch}
									onChanged={() => {
										queryClient.invalidateQueries({
											queryKey: ["agent-project-bindings", id],
										});
										queryClient.invalidateQueries({ queryKey: ["projects"] });
									}}
								/>
							</TabsContent>
						</div>
					</Tabs>
				</>
			) : null}
		</div>
	);
}

function parseAgentTab(value: string | null): AgentTab | null {
	if (value === "sessions" || value === "memories" || value === "skills" || value === "projects") {
		return value;
	}
	return null;
}

function AgentProjectsPanel({
	agentId,
	bindings,
	projects,
	isLoading,
	authedFetch,
	onChanged,
}: {
	agentId: string;
	bindings: ProjectBindingRow[];
	projects: ProjectRow[];
	isLoading: boolean;
	authedFetch: (path: string, init?: RequestInit) => Promise<Response>;
	onChanged: () => void;
}) {
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
			await authedFetch(`/api/agents/${agentId}/project-bindings/context`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ project_id: contextProjectId }),
			});
		},
		onSuccess: () => {
			setContextProjectId("");
			onChanged();
			toast.success("Project Added");
		},
		onError: (e) => toast.error("Couldn't add project", { description: errorMessage(e) }),
	});

	const removeBinding = useMutation({
		mutationFn: async (bindingId: string) => {
			await authedFetch(`/api/agents/${agentId}/project-bindings/${bindingId}`, {
				method: "DELETE",
			});
		},
		onSuccess: () => {
			onChanged();
			toast.success("Project Removed");
		},
		onError: (e) => toast.error("Couldn't remove project", { description: errorMessage(e) }),
	});

	const reorder = useMutation({
		mutationFn: async (items: Array<{ binding_id: string; priority: number }>) => {
			await authedFetch(`/api/agents/${agentId}/project-bindings/context/reorder`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ items }),
			});
		},
		onSuccess: () => {
			onChanged();
			toast.success("Project Order Updated");
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
