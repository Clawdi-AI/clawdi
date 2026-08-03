import { createFileRoute, redirect } from "@tanstack/react-router";
import { routeHeadTitle } from "@/lib/document-title";
import {
	legacyAgentResourceScope,
	projectDetailLink,
	validateResourceDetailSearch,
} from "@/lib/resource-navigation";
import ProjectDetailPage from "@/pages/dashboard/projects/[id]/page";

export const Route = createFileRoute("/_protected/_dashboard/projects/$id")({
	validateSearch: validateResourceDetailSearch,
	beforeLoad: ({ params, search }) => {
		const legacyScope = legacyAgentResourceScope(search, "projects");
		if (legacyScope) {
			throw redirect({ ...projectDetailLink(legacyScope, params.id), replace: true });
		}
	},
	head: () => routeHeadTitle("Project"),
	component: ProjectDetailRoute,
});

function ProjectDetailRoute() {
	const { id } = Route.useParams();
	return <ProjectDetailPage projectId={id} scope={{ kind: "library" }} />;
}
