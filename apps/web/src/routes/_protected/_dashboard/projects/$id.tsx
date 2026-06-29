import { createFileRoute } from "@tanstack/react-router";
import ProjectDetailPage from "@/pages/dashboard/projects/[id]/page";

export const Route = createFileRoute("/_protected/_dashboard/projects/$id")({
	component: ProjectDetailRoute,
});

function ProjectDetailRoute() {
	const { id } = Route.useParams();
	return <ProjectDetailPage projectId={id} />;
}
