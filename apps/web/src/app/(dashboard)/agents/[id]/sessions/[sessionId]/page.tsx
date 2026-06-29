"use client";

import { SessionDetailContent } from "@/app/(dashboard)/sessions/[id]/page";
import { useParams } from "@/lib/router-navigation";

export default function AgentSessionDetailPage() {
	const { id, sessionId } = useParams<{ id: string; sessionId: string }>();
	return <SessionDetailContent sessionId={sessionId} agentId={id} />;
}
