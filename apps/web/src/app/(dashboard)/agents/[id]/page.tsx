"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { useSetBreadcrumbTitle } from "@/components/breadcrumb-title";
import { AgentIcon } from "@/components/dashboard/agent-icon";
import { agentTypeLabel } from "@/components/dashboard/agent-label";
import { DetailMeta, DetailNotFound, DetailTitle } from "@/components/detail/layout";
import { sessionColumns } from "@/components/sessions/session-columns";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { Skeleton } from "@/components/ui/skeleton";
import { unwrap, useApi } from "@/lib/api";
import { errorMessage, relativeTime } from "@/lib/utils";

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

	const sessionTotal = sessionsPage?.total ?? 0;

	// Wait until `agent` is loaded — otherwise `agentTypeLabel(undefined)`
	// returns the literal "Unknown", which would briefly flash in the
	// breadcrumb during the initial query.
	useSetBreadcrumbTitle(agent ? agent.machine_name || agentTypeLabel(agent.agent_type) : null);

	const remove = useMutation({
		mutationFn: async () =>
			unwrap(
				await api.DELETE("/api/environments/{environment_id}", {
					params: { path: { environment_id: id } },
				}),
			),
		onSuccess: () => {
			toast.success("Agent removed", {
				description:
					sessionTotal > 0
						? `${sessionTotal} session${sessionTotal === 1 ? "" : "s"} kept (machine label dropped).`
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
		onError: (e) => toast.error("Failed to remove agent", { description: errorMessage(e) }),
	});

	const onRemove = () => {
		// Spell out *both* consequences so the user can't be surprised:
		//   1. Sessions stay but lose their machine label (server-side state).
		//   2. The CLI on this machine is now pointed at a deleted env_id;
		//      next `clawdi push` will hard-fail and prompt for re-setup.
		const sessionLine =
			sessionTotal > 0
				? `${sessionTotal} session${sessionTotal === 1 ? "" : "s"} will be kept but lose the machine label.\n\n`
				: "";
		const msg = `Remove this agent?\n\n${sessionLine}If this machine still has the clawdi CLI installed, you'll need to run \`clawdi setup\` again before the next push.`;
		if (window.confirm(msg)) remove.mutate();
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
					{/* Title row pairs the h1 with the destructive action so the
					    button doesn't float on its own line. items-start so a
					    long machine name wrapping doesn't drag the button down. */}
					<div className="space-y-2">
						<div className="flex items-start justify-between gap-3">
							<DetailTitle className="inline-flex items-center gap-2">
								<AgentIcon agent={agent.agent_type} className="size-7 rounded" />
								{agent.machine_name || agentTypeLabel(agent.agent_type)}
							</DetailTitle>
							<Button
								variant="outline"
								size="sm"
								onClick={onRemove}
								disabled={remove.isPending}
								className="shrink-0 text-destructive hover:text-destructive"
							>
								<Trash2 />
								Remove agent
							</Button>
						</div>
						<DetailMeta>
							<span>{agentTypeLabel(agent.agent_type)}</span>
							{agent.agent_version ? (
								<>
									<span>·</span>
									<span>v{agent.agent_version}</span>
								</>
							) : null}
							{agent.os ? (
								<>
									<span>·</span>
									<span>{agent.os}</span>
								</>
							) : null}
							{agent.last_seen_at ? (
								<>
									<span>·</span>
									<span>last seen {relativeTime(agent.last_seen_at)}</span>
								</>
							) : null}
						</DetailMeta>
					</div>

					<section className="space-y-2">
						<div className="flex items-end justify-between">
							<div>
								<h2 className="font-semibold text-base">Sessions from this agent</h2>
								<p className="text-sm text-muted-foreground">{sessionsPage?.total ?? 0} total</p>
							</div>
						</div>
						<DataTable
							columns={sessionColumns}
							data={sessionsPage?.items ?? []}
							isLoading={sessionsLoading}
							getRowHref={(s) => `/sessions/${s.id}`}
							rowAriaLabel={(s) => `Open session ${s.local_session_id}`}
							emptyMessage="No sessions synced from this agent yet."
						/>
					</section>
				</>
			) : null}
		</div>
	);
}
