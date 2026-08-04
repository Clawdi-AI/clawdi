import { createFileRoute } from "@tanstack/react-router";
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
	return <ProjectDetailPage projectId={projectId} scope={agentResourceScope(id, search)} />;
}
