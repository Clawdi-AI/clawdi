import { createFileRoute } from "@tanstack/react-router";
import SkillDetailPage from "@/pages/dashboard/skills/[key]/page";

export const Route = createFileRoute("/_protected/_dashboard/skills/$key")({
	component: SkillDetailRoute,
});

function SkillDetailRoute() {
	const { key } = Route.useParams();
	return <SkillDetailPage routeKey={key} />;
}
