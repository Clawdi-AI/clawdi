import { createFileRoute } from "@tanstack/react-router";
import AgentSessionDetailPage from "@/pages/dashboard/agents/agent-session-detail-page";

export const Route = createFileRoute("/_protected/_dashboard/agents/$id/sessions/$sessionId")({
	component: AgentSessionDetailRoute,
});

function AgentSessionDetailRoute() {
	const { id, sessionId } = Route.useParams();
	return <AgentSessionDetailPage agentId={id} sessionId={sessionId} />;
}
