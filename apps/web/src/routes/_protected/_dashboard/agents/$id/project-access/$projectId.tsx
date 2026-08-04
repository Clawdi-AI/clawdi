import { createFileRoute } from "@tanstack/react-router";
import { AgentResourceRouteGate } from "@/components/dashboard/agent-resource-route-gate";
import { agentDeploymentRouteQuery, agentSectionHref } from "@/lib/agent-routes";
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
	const projectsHref = agentSectionHref(id, "projects", agentDeploymentRouteQuery(search));
	return (
		<AgentResourceRouteGate
			agentId={id}
			returnHref={projectsHref}
			returnLabel="Agent Projects"
			projectAccess={{ projectId }}
		>
			<ProjectDetailPage projectId={projectId} scope={agentResourceScope(id, search, projectId)} />
		</AgentResourceRouteGate>
	);
}
