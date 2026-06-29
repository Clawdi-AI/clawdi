import { createFileRoute } from "@tanstack/react-router";
import AgentSessionDetailPage from "@/app/(dashboard)/agents/[id]/sessions/[sessionId]/page";

export const Route = createFileRoute("/_protected/_dashboard/agents/$id/sessions/$sessionId")({
	component: AgentSessionDetailPage,
});
