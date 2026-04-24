"use client";

import { useAuth } from "@clerk/nextjs";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { AgentLabel } from "@/components/dashboard/agent-label";
import { DetailHeader } from "@/components/detail-header";
import { sessionColumns } from "@/components/sessions/session-columns";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { Skeleton } from "@/components/ui/skeleton";
import { apiFetch } from "@/lib/api";
import type { Environment, PaginatedSessions } from "@/lib/api-schemas";
import { errorMessage, relativeTime } from "@/lib/utils";

export default function AgentDetailPage() {
	const { id } = useParams<{ id: string }>();
	const router = useRouter();
	const { getToken } = useAuth();

	const {
		data: agent,
		isLoading,
		error,
	} = useQuery({
		queryKey: ["agent", id],
		queryFn: async () => {
			const token = await getToken();
			if (!token) throw new Error("Not authenticated");
			return apiFetch<Environment>(`/api/environments/${id}`, token);
		},
	});

	const { data: sessionsPage, isLoading: sessionsLoading } = useQuery({
		queryKey: ["agent-sessions", id],
		queryFn: async () => {
			const token = await getToken();
			if (!token) throw new Error("Not authenticated");
			return apiFetch<PaginatedSessions>(`/api/sessions?environment_id=${id}&page_size=50`, token);
		},
		enabled: !!agent,
	});

	return (
		<div className="space-y-5 px-4 lg:px-6">
			<DetailHeader backHref="/" backLabel="Back to Overview" />

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
