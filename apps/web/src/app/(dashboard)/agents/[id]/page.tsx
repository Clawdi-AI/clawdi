"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Unplug } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useSetBreadcrumbTitle } from "@/components/breadcrumb-title";
import { AgentLabel, agentTypeLabel, cleanMachineName } from "@/components/dashboard/agent-label";
import { DaemonStatusBadge } from "@/components/dashboard/daemon-status";
import { DetailNotFound } from "@/components/detail/layout";
import { sessionColumns } from "@/components/sessions/session-columns";
import { makeSkillColumns } from "@/components/skills/skill-columns";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { unwrap, useApi } from "@/lib/api";
import type { components } from "@/lib/api-schemas";
import { errorMessage, relativeTime } from "@/lib/utils";

type SkillSummary = components["schemas"]["SkillSummaryResponse"];

export default function AgentDetailPage() {
	const { id } = useParams<{ id: string }>();
	const router = useRouter();
	const api = useApi();
	const queryClient = useQueryClient();

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

	// Skills section: fetch ONLY this env's scope. The earlier
	// shape loaded the first 200 account-wide rows and filtered
	// client-side, which on a multi-agent account with >200
	// skills could miss this agent's rows entirely if they fell
	// past page 1 in the global sort. The `scope_id` query
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
	const agentScopeId = agent?.default_scope_id;
	const { data: skillsData, isLoading: skillsLoading } = useQuery({
		queryKey: ["skills", agentScopeId, "all-pages"],
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
								scope_id: agentScopeId,
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
		enabled: !!agentScopeId,
	});
	const skillsForThisEnv = useMemo(() => {
		// `scope_id=...` filtered server-side, but defense-in-depth:
		// drop anything the server didn't filter (would be a backend
		// bug). Same shape downstream code expects.
		if (!skillsData?.items || !agentScopeId) return undefined;
		return skillsData.items.filter((s) => s.scope_id === agentScopeId);
	}, [skillsData, agentScopeId]);

	const uninstallSkill = useMutation({
		mutationFn: async ({ skillKey, scopeId }: { skillKey: string; scopeId: string }) =>
			unwrap(
				await api.DELETE("/api/scopes/{scope_id}/skills/{skill_key}", {
					params: { path: { scope_id: scopeId, skill_key: skillKey } },
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
				(skillKey, scopeId) => uninstallSkill.mutate({ skillKey, scopeId }),
				uninstallSkill.isPending,
			),
		[uninstallSkill.mutate, uninstallSkill.isPending],
	);

	const sessionTotal = sessionsPage?.total ?? 0;

	// Controlled tab state so the row-level "Install skills" button can
	// render only on the Skills tab — keeping the action contextual to
	// what the user is looking at, instead of floating an Install CTA
	// over a Sessions list it has nothing to do with.
	const [activeTab, setActiveTab] = useState<"sessions" | "skills">("sessions");

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
								<DaemonStatusBadge env={agent} />,
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
						onValueChange={(v) => setActiveTab(v as "sessions" | "skills")}
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
					</Tabs>
				</>
			) : null}
		</div>
	);
}
