import { createFileRoute } from "@tanstack/react-router";
import { routeHeadTitle } from "@/lib/document-title";
import { validateProjectDetailSearch } from "@/lib/project-resource-model";
import ProjectDetailPage from "@/pages/dashboard/projects/[id]/page";

export const Route = createFileRoute("/_protected/_dashboard/projects/$id")({
	validateSearch: validateProjectDetailSearch,
	head: () => routeHeadTitle("Project"),
	component: ProjectDetailRoute,
});

function ProjectDetailRoute() {
	const { id } = Route.useParams();
	const search = Route.useSearch();
	return <ProjectDetailPage projectId={id} routeSearch={search} />;
}
