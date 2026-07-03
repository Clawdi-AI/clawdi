"use client";

import { Link } from "@tanstack/react-router";
import { MessageSquare, Zap } from "lucide-react";
import { Stat } from "@/components/meta/stat";
import { SessionAgentLabel } from "@/components/sessions/session-agent-label";
import { Skeleton } from "@/components/ui/skeleton";
import type { SessionListItem } from "@/lib/api-schemas";
import { formatNumber, formatSessionSummary, relativeTime } from "@/lib/utils";

export function MobileSessionList({
	sessions,
	isLoading,
	emptyMessage,
}: {
	sessions: SessionListItem[];
	isLoading: boolean;
	emptyMessage: string;
}) {
	if (isLoading) {
		return (
			<div className="divide-y">
				{Array.from({ length: 3 }).map((_, index) => (
					<div key={index} className="px-4 py-3">
						<Skeleton className="h-4 w-4/5" />
						<Skeleton className="mt-2 h-3 w-1/2" />
						<Skeleton className="mt-3 h-3 w-2/3" />
					</div>
				))}
			</div>
		);
	}

	if (sessions.length === 0) {
		return <p className="px-4 py-8 text-center text-sm text-muted-foreground">{emptyMessage}</p>;
	}

	return (
		<div className="divide-y">
			{sessions.map((session) => {
				const title = formatSessionSummary(session.summary) || session.local_session_id.slice(0, 8);
				const projectFolder = session.project_path?.split("/").pop();
				const totalTokens = session.input_tokens + session.output_tokens;
				return (
					<article key={session.id} className="px-4 py-3">
						<Link to="/sessions/$id" params={{ id: session.id }} className="block min-w-0">
							<div className="min-w-0">
								<h3 className="truncate text-sm font-medium">{title}</h3>
								{projectFolder ? (
									<p className="mt-0.5 truncate text-xs text-muted-foreground">{projectFolder}</p>
								) : null}
							</div>
							<div className="mt-3 flex items-center justify-between gap-3">
								<SessionAgentLabel session={session} size="sm" />
								<span className="shrink-0 text-xs text-muted-foreground">
									{relativeTime(session.last_activity_at)}
								</span>
							</div>
							<div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
								<Stat icon={MessageSquare} label={`${session.message_count} messages`} />
								<Stat icon={Zap} label={`${formatNumber(totalTokens)} tokens`} />
								<span>Started {relativeTime(session.started_at)}</span>
							</div>
						</Link>
					</article>
				);
			})}
		</div>
	);
}
