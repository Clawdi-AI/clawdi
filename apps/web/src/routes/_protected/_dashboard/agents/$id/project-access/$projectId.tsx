import { createFileRoute, Outlet } from "@tanstack/react-router";
import { AgentResourceRouteGate } from "@/components/dashboard/agent-resource-route-gate";
import { agentDeploymentRouteQuery, agentSectionHref } from "@/lib/agent-routes";
import { routeHeadTitle } from "@/lib/document-title";

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
			<Outlet />
		</AgentResourceRouteGate>
	);
}
