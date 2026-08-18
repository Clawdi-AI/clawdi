import { createFileRoute } from "@tanstack/react-router";
import { routeHeadTitle } from "@/lib/document-title";
import { agentResourceScope } from "@/lib/resource-navigation";
import ProjectDetailPage from "@/pages/dashboard/projects/[id]/page";

export const Route = createFileRoute(
	"/_protected/_dashboard/agents/$id/project-access/$projectId/skills",
)({
	head: () => routeHeadTitle("Skills"),
	component: AgentProjectSkillsRoute,
});

function AgentProjectSkillsRoute() {
	const { id, projectId } = Route.useParams();
	return (
		<ProjectDetailPage
			projectId={projectId}
			scope={agentResourceScope(id, projectId)}
			focus="skills"
		/>
	);
}
