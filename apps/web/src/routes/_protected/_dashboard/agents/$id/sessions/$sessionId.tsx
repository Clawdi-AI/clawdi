import { createFileRoute } from "@tanstack/react-router";
import { AgentResourceRouteGate } from "@/components/dashboard/agent-resource-route-gate";
import { agentSectionHref } from "@/lib/agent-routes";
import { routeHeadTitle } from "@/lib/document-title";
import { parseSessionTimelineView } from "@/lib/session-search-anchor";
import AgentSessionDetailPage from "@/pages/dashboard/agents/agent-session-detail-page";

export const Route = createFileRoute("/_protected/_dashboard/agents/$id/sessions/$sessionId")({
	head: () => routeHeadTitle("Session"),
	component: AgentSessionDetailRoute,
});

function AgentSessionDetailRoute() {
	const { id, sessionId } = Route.useParams();
	const search = Route.useSearch();
	return (
		<AgentResourceRouteGate
			agentId={id}
			returnHref={agentSectionHref(id, "overview")}
			returnLabel="Agent overview"
			requiredAdapterModule="sessions"
		>
			<AgentSessionDetailPage
				agentId={id}
				sessionId={sessionId}
				timelineView={parseSessionTimelineView(search.timelineView) ?? "all"}
			/>
		</AgentResourceRouteGate>
	);
}
