"use client";

import { useAuth } from "@clerk/nextjs";
import { useQuery } from "@tanstack/react-query";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { SessionRow, SessionRowSkeleton } from "@/components/sessions/session-row";
import { Badge } from "@/components/ui/badge";
import { apiFetch } from "@/lib/api";
import type { SessionListItem } from "@/lib/api-schemas";

export default function SessionsPage() {
	const { getToken } = useAuth();

	const { data: sessions, isLoading } = useQuery({
		queryKey: ["sessions"],
		queryFn: async () => {
			const token = await getToken();
			if (!token) throw new Error("Not authenticated");
			return apiFetch<SessionListItem[]>("/api/sessions?limit=100", token);
		},
	});

	return (
		<div className="space-y-5 px-4 lg:px-6">
			<PageHeader
				title="Sessions"
				description="Agent conversations synced from your machines."
				actions={
					sessions ? (
						<Badge variant="secondary">
							{sessions.length} session{sessions.length === 1 ? "" : "s"}
						</Badge>
					) : null
				}
			/>

			{isLoading ? (
				<div className="divide-y rounded-lg border bg-card">
					{Array.from({ length: 6 }).map((_, i) => (
						<SessionRowSkeleton key={i} />
					))}
				</div>
			) : sessions?.length ? (
				<div className="divide-y rounded-lg border bg-card">
					{sessions.map((s) => (
						<SessionRow key={s.id} session={s} />
					))}
				</div>
			) : (
				<EmptyState
					description={
						<>
							No sessions yet. Run{" "}
							<code className="bg-muted px-1.5 py-0.5 rounded text-xs">clawdi sync up</code> to
							sync.
						</>
					}
				/>
			)}
		</div>
	);
}
