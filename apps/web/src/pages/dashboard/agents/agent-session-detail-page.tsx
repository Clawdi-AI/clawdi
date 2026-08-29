"use client";

import type { SessionTimelineView } from "@/lib/session-search-anchor";
import { SessionDetailContent } from "@/pages/dashboard/sessions/[id]/page";

type AgentSessionDetailPageProps = {
	agentId: string;
	sessionId: string;
	timelineView: SessionTimelineView;
};

export default function AgentSessionDetailPage({
	agentId,
	sessionId,
	timelineView,
}: AgentSessionDetailPageProps) {
	return (
		<SessionDetailContent sessionId={sessionId} agentId={agentId} timelineView={timelineView} />
	);
}
