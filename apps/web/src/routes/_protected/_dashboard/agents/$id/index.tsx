import { createFileRoute } from "@tanstack/react-router";
import { routeHeadTitle } from "@/lib/document-title";
import { AgentDetailClient } from "@/pages/dashboard/agents/agent-detail-client";

export const Route = createFileRoute("/_protected/_dashboard/agents/$id/")({
	head: () => routeHeadTitle("Agent"),
	component: AgentDetailRoute,
});

function AgentDetailRoute() {
	const { id } = Route.useParams();
	const search = Route.useSearch();
	return <AgentDetailClient environmentId={id} section="overview" routeSearch={search} />;
}
