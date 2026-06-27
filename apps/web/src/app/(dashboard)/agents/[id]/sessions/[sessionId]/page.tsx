"use client";

import { useParams } from "next/navigation";
import { SessionDetailContent } from "@/app/(dashboard)/sessions/[id]/page";

export default function AgentSessionDetailPage() {
	const { id, sessionId } = useParams<{ id: string; sessionId: string }>();
	return <SessionDetailContent sessionId={sessionId} agentId={id} />;
}
