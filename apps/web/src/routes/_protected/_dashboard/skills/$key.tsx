import { createFileRoute } from "@tanstack/react-router";
import { routeHeadTitle } from "@/lib/document-title";
import { validateResourceDetailSearch } from "@/lib/resource-navigation";
import SkillDetailPage from "@/pages/dashboard/skills/[key]/page";

export const Route = createFileRoute("/_protected/_dashboard/skills/$key")({
	validateSearch: validateResourceDetailSearch,
	head: () => routeHeadTitle("Skill"),
	component: SkillDetailRoute,
});

function SkillDetailRoute() {
	const { key } = Route.useParams();
	return <SkillDetailPage routeKey={key} />;
}
