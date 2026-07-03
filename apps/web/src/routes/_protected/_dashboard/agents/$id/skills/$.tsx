import { createFileRoute } from "@tanstack/react-router";
import { routeHeadTitle } from "@/lib/document-title";
import { decodeResourceRouteParam } from "@/lib/project-resource-model";
import { SkillDetailContent } from "@/pages/dashboard/skills/[key]/page";

export const Route = createFileRoute("/_protected/_dashboard/agents/$id/skills/$")({
	head: () => routeHeadTitle("Skill"),
	component: AgentSkillDetailRoute,
});

function AgentSkillDetailRoute() {
	const { id, _splat } = Route.useParams();
	const skillKey = (_splat ?? "").split("/").map(decodeResourceRouteParam).join("/");
	return <SkillDetailContent agentId={id} skillKey={skillKey} />;
}
