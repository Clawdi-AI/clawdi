import { createFileRoute } from "@tanstack/react-router";
import { routeHeadTitle } from "@/lib/document-title";
import ProjectDetailPage from "@/pages/dashboard/projects/[id]/page";

export const Route = createFileRoute("/_protected/_dashboard/projects/$id")({
	head: () => routeHeadTitle("Project"),
	component: ProjectDetailRoute,
});

function ProjectDetailRoute() {
	const { id } = Route.useParams();
	return <ProjectDetailPage projectId={id} />;
}
