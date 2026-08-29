import { createFileRoute } from "@tanstack/react-router";
import { AgentResourceRouteGate } from "@/components/dashboard/agent-resource-route-gate";
import { agentSectionHref } from "@/lib/agent-routes";
import { routeHeadTitle } from "@/lib/document-title";
import {
	sessionSearchAnchorFromSearch,
	validateSessionDetailSearch,
} from "@/lib/session-search-anchor";
import AgentSessionDetailPage from "@/pages/dashboard/agents/agent-session-detail-page";

export const Route = createFileRoute("/_protected/_dashboard/agents/$id/sessions/$sessionId")({
	validateSearch: validateSessionDetailSearch,
	head: () => routeHeadTitle("Session"),
	component: AgentSessionDetailRoute,
});

function AgentSessionDetailRoute() {
	const { id, sessionId } = Route.useParams();
	const search = Route.useSearch();
	const searchAnchor = sessionSearchAnchorFromSearch(search);
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
				searchAnchor={searchAnchor}
				searchQuery={search.matchQuery}
				timelineView={search.timelineView ?? "all"}
			/>
		</AgentResourceRouteGate>
	);
}
