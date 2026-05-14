"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, GitBranch, Plus, Trash2, Unplug } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useSetBreadcrumbTitle } from "@/components/breadcrumb-title";
import { AgentLabel, agentTypeLabel, cleanMachineName } from "@/components/dashboard/agent-label";
import { DaemonStatusBadge } from "@/components/dashboard/daemon-status";
import { DetailNotFound } from "@/components/detail/layout";
import { sessionColumns } from "@/components/sessions/session-columns";
import { makeSkillColumns } from "@/components/skills/skill-columns";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { unwrap, useApi, useAuthedFetch } from "@/lib/api";
import type { components } from "@/lib/api-schemas";
import { errorMessage, relativeTime } from "@/lib/utils";

type SkillSummary = components["schemas"]["SkillSummaryResponse"];

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
	const SKILLS_PAGE_SIZE = 200;
	const agentProjectId = agent?.default_project_id;
	const { data: skillsData, isLoading: skillsLoading } = useQuery({
		queryKey: ["skills", agentProjectId, "all-pages"],
		queryFn: async () => {
			const items: SkillSummary[] = [];
			let page = 1;
			let total = 0;
			while (true) {
				const result = unwrap(
					await api.GET("/api/skills", {
						params: {
							query: {
								page,
								page_size: SKILLS_PAGE_SIZE,
								project_id: agentProjectId,
							},
						},
					}),
				);
				items.push(...result.items);
				total = result.total ?? items.length;
				if (items.length >= total || result.items.length === 0) break;
				page += 1;
				if (page > 50) break;
			}
			return { items, total, page: 1, page_size: SKILLS_PAGE_SIZE };
		},
		enabled: !!agentProjectId,
	});
	const skillsForThisEnv = useMemo(() => {
		// `?project_id=<agentProjectId>` narrows the listing to the
		// selected project. Shared-project rows render as read-only via
		// `ownedProjectId` handling in `skill-columns`.
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
			toast.success(
				`Uninstalled ${vars.skillKey} from this agent. Other agents keep their copies.`,
			);
			queryClient.invalidateQueries({ queryKey: ["skills"] });
		},
		onError: (e) => toast.error("Failed to uninstall skill", { description: errorMessage(e) }),
	});

	const skillColumns = useMemo(
		() =>
			makeSkillColumns(
				(skillKey, projectId) => uninstallSkill.mutate({ skillKey, projectId }),
				uninstallSkill.isPending,
				agentProjectId,
			),
		[uninstallSkill.mutate, uninstallSkill.isPending, agentProjectId],
	);

	const sessionTotal = sessionsPage?.total ?? 0;

	// Controlled tab state so the row-level "Install skills" button can
	// render only on the Skills tab — keeping the action contextual to
	// what the user is looking at, instead of floating an Install CTA
	// over a Sessions list it has nothing to do with.
	const [activeTab, setActiveTab] = useState<"sessions" | "skills" | "projects">("sessions");

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
		onError: (e) => toast.error("Failed to disconnect agent", { description: errorMessage(e) }),
	});

	const onDisconnect = () => {
		// "Disconnect" not "Remove" — the API call only deletes the
		// AgentEnvironment row. Sessions, skills, and memories all
		// stay (backend `delete_environment` docstring spells this
		// out: "Existing sessions remain (orphaned) so users don't
		// lose history when removing a machine.")
		const msg =
			"Disconnect this agent from your account?\n\n" +
			"Sessions and skills stay in your account, but this agent will stop syncing and " +
			"sessions will no longer be tagged with it. If sync is still running there, " +
			"reconnect from that agent to resume.";
		if (window.confirm(msg)) disconnect.mutate();
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
						<Button
							variant="outline"
							size="sm"
							onClick={onDisconnect}
							disabled={disconnect.isPending}
							// Neutral tone, amber icon — Disconnect is fully
							// reversible (sessions/skills/memories all stay),
							// so a red destructive button would lie about the
							// consequences.
							className="shrink-0"
						>
							<Unplug className="text-amber-600 dark:text-amber-500" />
							Disconnect
						</Button>
					</div>

					{/* Tabs for the two large per-agent surfaces. Sessions
					    is the primary view (history is what the user
					    usually came to see); Skills is one click away
					    when they want to manage what's installed. Both
					    use shared <DataTable> + ColumnDef<T>[] pattern,
					    same as /sessions and /memories — one list
					    primitive everywhere. */}
					<Tabs
						value={activeTab}
						onValueChange={(v) => setActiveTab(v as "sessions" | "skills" | "projects")}
						className="gap-4"
					>
						{/* Tab strip + contextual action on the same row.
						    "Install skills" lives next to the Skills tab,
						    not below the table — keeps the CTA visible
						    above the fold when the table is empty, and
						    avoids a lonely button taking its own row. */}
						<div className="flex items-center justify-between gap-3">
							<TabsList>
								<TabsTrigger value="sessions">
									Sessions
									<span className="ml-1.5 text-xs text-muted-foreground">{sessionTotal}</span>
								</TabsTrigger>
								<TabsTrigger value="skills">
									Skills
									{skillsForThisEnv ? (
										<span className="ml-1.5 text-xs text-muted-foreground">
											{skillsForThisEnv.length}
										</span>
									) : null}
								</TabsTrigger>
								<TabsTrigger value="projects">
									Projects
									{projectBindings ? (
										<span className="ml-1.5 text-xs text-muted-foreground">
											{projectBindings.length}
										</span>
									) : null}
								</TabsTrigger>
							</TabsList>
							{activeTab === "skills" ? (
								<Button asChild variant="outline" size="sm">
									<Link href={`/skills?target=${encodeURIComponent(id)}`}>
										<Plus />
										Install skills
									</Link>
								</Button>
							) : null}
						</div>

						<TabsContent value="sessions" className="mt-0">
							<DataTable
								columns={sessionColumns}
								data={sessionsPage?.items ?? []}
								isLoading={sessionsLoading}
								getRowHref={(s) => `/sessions/${s.id}`}
								rowAriaLabel={(s) => `Open session ${s.local_session_id}`}
								emptyMessage="No sessions synced from this agent yet."
							/>
						</TabsContent>

						<TabsContent value="skills" className="mt-0">
							<DataTable
								columns={skillColumns}
								data={skillsForThisEnv ?? []}
								isLoading={skillsLoading}
								rowAriaLabel={(s) => `Open ${s.name}`}
								emptyMessage="No skills installed on this agent yet."
							/>
						</TabsContent>

						<TabsContent value="projects" className="mt-0">
							<ProjectBindingsPanel
								agentId={id}
								bindings={projectBindings ?? []}
								projects={projects ?? []}
								isLoading={projectBindingsLoading}
								authedFetch={authedFetch}
								onChanged={() => {
									queryClient.invalidateQueries({ queryKey: ["agent-project-bindings", id] });
									queryClient.invalidateQueries({ queryKey: ["projects"] });
								}}
							/>
						</TabsContent>
					</Tabs>
				</>
			) : null}
		</div>
	);
}

function ProjectBindingsPanel({
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
	const [primaryProjectId, setPrimaryProjectId] = useState("");
	const [contextProjectId, setContextProjectId] = useState("");
	const [contextPriority, setContextPriority] = useState("");
	const primary = bindings.find((binding) => binding.binding_type === "primary") ?? null;
	const contexts = bindings
		.filter((binding) => binding.binding_type === "context")
		.sort((a, b) => a.priority - b.priority);
	const projectsById = useMemo(
		() => new Map(projects.map((project) => [project.id, project])),
		[projects],
	);
	const ownedProjects = projects.filter((project) => project.is_owner !== false);
	const contextChoices = projects.filter(
		(project) => !bindings.some((binding) => binding.project_id === project.id),
	);

	const setPrimary = useMutation({
		mutationFn: async (projectId: string) => {
			await authedFetch(`/api/agents/${agentId}/project-bindings/primary`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ project_id: projectId }),
			});
		},
		onSuccess: () => {
			setPrimaryProjectId("");
			onChanged();
			toast.success("Primary project updated");
		},
		onError: (e) => toast.error("Failed to set primary project", { description: errorMessage(e) }),
	});

	const addContext = useMutation({
		mutationFn: async () => {
			const priority = contextPriority ? Number.parseInt(contextPriority, 10) : undefined;
			await authedFetch(`/api/agents/${agentId}/project-bindings/context`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ project_id: contextProjectId, priority }),
			});
		},
		onSuccess: () => {
			setContextProjectId("");
			setContextPriority("");
			onChanged();
			toast.success("Context project added");
		},
		onError: (e) => toast.error("Failed to add context project", { description: errorMessage(e) }),
	});

	const removeBinding = useMutation({
		mutationFn: async (bindingId: string) => {
			await authedFetch(`/api/agents/${agentId}/project-bindings/${bindingId}`, {
				method: "DELETE",
			});
		},
		onSuccess: () => {
			onChanged();
			toast.success("Context project removed");
		},
		onError: (e) =>
			toast.error("Failed to remove context project", { description: errorMessage(e) }),
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
			toast.success("Project order updated");
		},
		onError: (e) => toast.error("Failed to reorder projects", { description: errorMessage(e) }),
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
			<div className="grid gap-3 xl:grid-cols-2">
				<div className="space-y-3 rounded-lg border p-3">
					<div className="flex items-center gap-2">
						<GitBranch className="size-4 text-muted-foreground" />
						<h2 className="text-sm font-semibold">Primary Project</h2>
					</div>
					{primary ? (
						<ProjectBindingLine binding={primary} project={projectsById.get(primary.project_id)} />
					) : (
						<p className="text-sm text-muted-foreground">No explicit primary binding yet.</p>
					)}
					<div className="flex flex-col gap-2 sm:flex-row">
						<ProjectSelect
							value={primaryProjectId}
							onValueChange={setPrimaryProjectId}
							projects={ownedProjects}
							placeholder="Choose owned project"
						/>
						<Button
							size="sm"
							disabled={!primaryProjectId || setPrimary.isPending}
							onClick={() => setPrimary.mutate(primaryProjectId)}
						>
							Set primary
						</Button>
					</div>
				</div>

				<div className="space-y-3 rounded-lg border p-3">
					<div className="flex items-center gap-2">
						<GitBranch className="size-4 text-muted-foreground" />
						<h2 className="text-sm font-semibold">Add Context</h2>
					</div>
					<div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_96px_auto]">
						<ProjectSelect
							value={contextProjectId}
							onValueChange={setContextProjectId}
							projects={contextChoices}
							placeholder="Choose project"
						/>
						<Input
							value={contextPriority}
							type="number"
							min={1}
							placeholder="Order"
							onChange={(event) => setContextPriority(event.target.value)}
						/>
						<Button
							size="sm"
							disabled={!contextProjectId || addContext.isPending}
							onClick={() => addContext.mutate()}
						>
							<Plus className="size-3.5" />
							Add
						</Button>
					</div>
				</div>
			</div>

			<section className="space-y-2">
				<div className="flex items-center justify-between gap-2">
					<h2 className="text-sm font-semibold">Context Projects</h2>
					<Badge variant="secondary">{contexts.length}</Badge>
				</div>
				{contexts.length === 0 ? (
					<div className="rounded-lg border border-dashed px-4 py-6 text-sm text-muted-foreground">
						No context projects are bound to this agent.
					</div>
				) : (
					<div className="divide-y rounded-lg border">
						{contexts.map((binding, index) => (
							<div
								key={binding.id}
								className="grid gap-3 px-3 py-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center"
							>
								<ProjectBindingLine
									binding={binding}
									project={projectsById.get(binding.project_id)}
								/>
								<div className="flex items-center justify-end gap-1">
									<Button
										variant="ghost"
										size="icon-sm"
										disabled={index === 0 || reorder.isPending}
										onClick={() => moveContext(binding.id, -1)}
										aria-label="Move context project up"
									>
										<ArrowUp className="size-3.5" />
									</Button>
									<Button
										variant="ghost"
										size="icon-sm"
										disabled={index === contexts.length - 1 || reorder.isPending}
										onClick={() => moveContext(binding.id, 1)}
										aria-label="Move context project down"
									>
										<ArrowDown className="size-3.5" />
									</Button>
									<Button
										variant="ghost"
										size="icon-sm"
										disabled={removeBinding.isPending && removeBinding.variables === binding.id}
										onClick={() => removeBinding.mutate(binding.id)}
										aria-label="Remove context project"
									>
										<Trash2 className="size-3.5 text-destructive" />
									</Button>
								</div>
							</div>
						))}
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
	placeholder,
}: {
	value: string;
	onValueChange: (value: string) => void;
	projects: ProjectRow[];
	placeholder: string;
}) {
	return (
		<Select value={value} onValueChange={onValueChange}>
			<SelectTrigger className="w-full min-w-0">
				<SelectValue placeholder={placeholder} />
			</SelectTrigger>
			<SelectContent>
				{projects.map((project) => (
					<SelectItem key={project.id} value={project.id}>
						{project.is_owner === false && project.owner_handle
							? `@${project.owner_handle}/${project.slug}`
							: project.slug}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

function ProjectBindingLine({
	binding,
	project,
}: {
	binding: ProjectBindingRow;
	project: ProjectRow | undefined;
}) {
	const label = project
		? project.is_owner === false && project.owner_handle
			? `@${project.owner_handle}/${project.slug}`
			: project.slug
		: binding.project_id;
	return (
		<div className="min-w-0">
			<div className="flex flex-wrap items-center gap-2">
				<span className="truncate text-sm font-medium">{project?.name ?? label}</span>
				<Badge variant={binding.binding_type === "primary" ? "secondary" : "outline"}>
					{binding.binding_type}
				</Badge>
				{project?.is_owner === false ? <Badge variant="secondary">viewer</Badge> : null}
			</div>
			<div className="mt-1 truncate font-mono text-xs text-muted-foreground">
				{label} · priority {binding.priority}
			</div>
		</div>
	);
}
