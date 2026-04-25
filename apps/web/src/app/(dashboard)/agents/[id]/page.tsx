"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Trash2 } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { AgentLabel } from "@/components/dashboard/agent-label";
import { DetailHeader } from "@/components/detail-header";
import { sessionColumns } from "@/components/sessions/session-columns";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
			<DetailHeader
				backHref="/"
				backLabel="Back to Overview"
				actions={
					agent && !isLoading ? (
						<Button
							variant="outline"
							size="sm"
							onClick={onRemove}
							disabled={remove.isPending}
							className="text-destructive hover:text-destructive"
						>
							<Trash2 />
							Remove agent
						</Button>
					) : null
				}
			/>

			{error ? (
				<Alert variant="destructive">
					<AlertCircle />
					<AlertTitle>Agent not found</AlertTitle>
					<AlertDescription>{errorMessage(error)}</AlertDescription>
				</Alert>
			) : isLoading ? (
				<Card>
					<CardContent className="space-y-3 py-6">
						<Skeleton className="h-10 w-48" />
						<Skeleton className="h-4 w-64" />
					</CardContent>
				</Card>
			) : agent ? (
				<>
					<Card>
						<CardContent className="space-y-4 py-4">
							<AgentLabel machineName={agent.machine_name} type={agent.agent_type} size="lg" />
							<dl className="grid gap-3 border-t pt-4 text-sm sm:grid-cols-3">
								<div>
									<dt className="text-xs text-muted-foreground">Version</dt>
									<dd>{agent.agent_version ? `v${agent.agent_version}` : "—"}</dd>
								</div>
								<div>
									<dt className="text-xs text-muted-foreground">OS</dt>
									<dd>{agent.os ?? "—"}</dd>
								</div>
								<div>
									<dt className="text-xs text-muted-foreground">Last seen</dt>
									<dd>{agent.last_seen_at ? relativeTime(agent.last_seen_at) : "—"}</dd>
								</div>
							</dl>
						</CardContent>
					</Card>

					<section className="space-y-2">
						<div className="flex items-end justify-between">
							<div>
								<h2 className="text-base font-semibold">Sessions from this agent</h2>
								<p className="text-sm text-muted-foreground">{sessionsPage?.total ?? 0} total</p>
							</div>
						</div>
						<DataTable
							columns={sessionColumns}
							data={sessionsPage?.items ?? []}
							isLoading={sessionsLoading}
							onRowClick={(s) => router.push(`/sessions/${s.id}`)}
							emptyMessage="No sessions synced from this agent yet."
						/>
					</section>
				</>
			) : null}
		</div>
	);
}
