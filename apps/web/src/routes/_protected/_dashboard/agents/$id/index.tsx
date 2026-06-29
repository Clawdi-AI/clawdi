import { createFileRoute, redirect } from "@tanstack/react-router";
import { AgentDetailClient } from "@/app/(dashboard)/agents/[id]/agent-detail-client";
import { agentSectionHref, hasAgentTabQuery } from "@/lib/agent-routes";

export const Route = createFileRoute("/_protected/_dashboard/agents/$id/")({
	beforeLoad: ({ params, search }) => {
		if (hasAgentTabQuery(search)) {
			throw redirect({ to: agentSectionHref(params.id, "overview", search), replace: true });
		}
	},
	component: AgentDetailRoute,
});

function AgentDetailRoute() {
	const { id } = Route.useParams();
	return <AgentDetailClient environmentId={id} section="overview" />;
}
