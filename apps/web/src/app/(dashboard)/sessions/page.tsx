"use client";

import { useAuth } from "@clerk/nextjs";
import { useQuery } from "@tanstack/react-query";
import { Zap } from "lucide-react";
import Link from "next/link";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { apiFetch } from "@/lib/api";
import type { SessionListItem } from "@/lib/api-schemas";
import { cn, formatSessionSummary, relativeTime } from "@/lib/utils";

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
				description="Agent conversation history synced from your machines."
				actions={
					sessions ? (
						<Badge variant="secondary">
							{sessions.length} session{sessions.length === 1 ? "" : "s"}
						</Badge>
					) : null
				}
			/>

			{isLoading ? (
				<div className="rounded-lg border">
					{Array.from({ length: 6 }).map((_, i) => (
						<div key={i} className={cn("px-4 py-3 space-y-1.5", i > 0 && "border-t")}>
							<Skeleton className="h-4 w-64" />
							<div className="flex gap-2">
								<Skeleton className="h-3 w-20" />
								<Skeleton className="h-3 w-16" />
								<Skeleton className="h-3 w-12" />
							</div>
						</div>
					))}
				</div>
			) : sessions?.length ? (
				<div className="rounded-lg border">
					{sessions.map((s, i) => (
						<Link
							key={s.id}
							href={`/sessions/${s.id}`}
							className={cn(
								"flex items-center justify-between px-4 py-3 hover:bg-accent/40 transition-colors",
								i > 0 && "border-t",
							)}
						>
							<div className="min-w-0 flex-1">
								<div className="text-sm font-medium truncate">
									{formatSessionSummary(s.summary) || s.local_session_id.slice(0, 8)}
								</div>
								<div className="flex items-center gap-2 mt-0.5">
									{s.agent_type && (
										<span className="text-[10px] rounded bg-primary/10 px-1.5 py-0.5 text-primary font-medium">
											{s.agent_type === "claude_code"
												? "Claude Code"
												: s.agent_type === "hermes"
													? "Hermes"
													: s.agent_type}
										</span>
									)}
									<span className="text-xs text-muted-foreground">
										{s.project_path?.split("/").pop() ?? "-"}
									</span>
									{s.model && (
										<span className="text-[10px] rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
											{s.model.replace("claude-", "")}
										</span>
									)}
									<span className="text-xs text-muted-foreground">{s.message_count} msgs</span>
									<span className="text-xs text-muted-foreground">
										<Zap className="inline size-3" />{" "}
										{((s.input_tokens + s.output_tokens) / 1000).toFixed(1)}k
									</span>
								</div>
							</div>
							<span className="text-xs text-muted-foreground ml-4 shrink-0">
								{relativeTime(s.started_at)}
							</span>
						</Link>
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
