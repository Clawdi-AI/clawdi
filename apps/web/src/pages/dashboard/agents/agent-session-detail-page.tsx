"use client";

import { SessionDetailContent } from "@/pages/dashboard/sessions/[id]/page";

type AgentSessionDetailPageProps = {
	agentId: string;
	sessionId: string;
};

export default function AgentSessionDetailPage({
	agentId,
	sessionId,
}: AgentSessionDetailPageProps) {
	return <SessionDetailContent sessionId={sessionId} agentId={agentId} />;
}
