import { createFileRoute } from "@tanstack/react-router";
import { AgentResourceRouteGate } from "@/components/dashboard/agent-resource-route-gate";
import { agentSectionHref } from "@/lib/agent-routes";
import { routeHeadTitle } from "@/lib/document-title";
import { agentResourceScope } from "@/lib/resource-navigation";
import ProjectDetailPage from "@/pages/dashboard/projects/[id]/page";

export const Route = createFileRoute("/_protected/_dashboard/agents/$id/project-access/$projectId")(
	{
		head: () => routeHeadTitle("Project"),
		component: AgentProjectDetailRoute,
	},
);

function AgentProjectDetailRoute() {
	const { id, projectId } = Route.useParams();
	const search = Route.useSearch();
	const scope = agentResourceScope(id, search, projectId);
	return (
		<AgentResourceRouteGate
			agentId={id}
			returnHref={agentSectionHref(id, "projects", search)}
			returnLabel="Agent Projects"
		>
			<ProjectDetailPage projectId={projectId} scope={scope} />
		</AgentResourceRouteGate>
	);
}
