"use client";

import type { SessionSearchAnchor, SessionTimelineView } from "@/lib/session-search-anchor";
import { SessionDetailContent } from "@/pages/dashboard/sessions/[id]/page";

type AgentSessionDetailPageProps = {
	agentId: string;
	sessionId: string;
	searchAnchor?: SessionSearchAnchor;
	searchQuery?: string;
	timelineView: SessionTimelineView;
};

export default function AgentSessionDetailPage({
	agentId,
	sessionId,
	searchAnchor,
	searchQuery,
	timelineView,
}: AgentSessionDetailPageProps) {
	return (
		<SessionDetailContent
			key={sessionId}
			sessionId={sessionId}
			agentId={agentId}
			searchAnchor={searchAnchor}
			searchQuery={searchQuery}
			timelineView={timelineView}
		/>
	);
}
