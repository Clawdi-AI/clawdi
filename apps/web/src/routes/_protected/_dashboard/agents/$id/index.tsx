import { createFileRoute, redirect } from "@tanstack/react-router";
import { agentSectionHref, hasAgentTabQuery } from "@/lib/agent-routes";
import { AgentDetailClient } from "@/pages/dashboard/agents/agent-detail-client";

export const Route = createFileRoute("/_protected/_dashboard/agents/$id/")({
	beforeLoad: ({ params, search }) => {
		if (hasAgentTabQuery(search)) {
			throw redirect({ href: agentSectionHref(params.id, "overview", search), replace: true });
		}
	},
	component: AgentDetailRoute,
});

function AgentDetailRoute() {
	const { id } = Route.useParams();
	return <AgentDetailClient environmentId={id} section="overview" />;
}
