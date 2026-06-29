import { createFileRoute } from "@tanstack/react-router";
import { SkillDetailContent } from "@/app/(dashboard)/skills/[key]/page";
import { decodeResourceRouteParam } from "@/lib/project-resource-model";

export const Route = createFileRoute("/_protected/_dashboard/agents/$id/skills/$")({
	component: AgentSkillDetailRoute,
});

function AgentSkillDetailRoute() {
	const { id, _splat } = Route.useParams();
	const skillKey = (_splat ?? "").split("/").map(decodeResourceRouteParam).join("/");
	return <SkillDetailContent agentId={id} skillKey={skillKey} />;
}
