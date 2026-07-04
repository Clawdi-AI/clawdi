"use client";

import { Link } from "@tanstack/react-router";
import { AgentIcon } from "@/components/dashboard/agent-icon";
import { agentIdentity } from "@/components/dashboard/agent-label";
import { EntityHeader } from "@/components/entity-card";
import { sessionAgentIdentityInput } from "@/components/sessions/session-agent-label";
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
				const agent = agentIdentity(sessionAgentIdentityInput(session)).primaryLabel;
				return (
					<article key={session.id} className="px-4 py-3">
						<Link to="/sessions/$id" params={{ id: session.id }} className="block min-w-0">
							<EntityHeader
								align="start"
								icon={<AgentIcon agent={session.agent_type} size="lg" />}
								title={title}
								meta={[
									agent,
									projectFolder,
									`${session.message_count} messages`,
									`${formatNumber(totalTokens)} tokens`,
									relativeTime(session.last_activity_at),
									`started ${relativeTime(session.started_at)}`,
								]}
							/>
						</Link>
					</article>
				);
			})}
		</div>
	);
}
