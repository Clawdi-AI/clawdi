import { createFileRoute } from "@tanstack/react-router";
import { AgentResourceRouteGate } from "@/components/dashboard/agent-resource-route-gate";
import { agentDeploymentRouteQuery, agentSectionHref } from "@/lib/agent-routes";
import { routeHeadTitle } from "@/lib/document-title";
import { decodeResourceRouteParam } from "@/lib/project-resource-model";
import { SkillDetailContent } from "@/pages/dashboard/skills/[key]/page";

export const Route = createFileRoute("/_protected/_dashboard/agents/$id/skills/$")({
	head: () => routeHeadTitle("Skill"),
	component: AgentSkillDetailRoute,
});

function AgentSkillDetailRoute() {
	const { id, _splat } = Route.useParams();
	const search = Route.useSearch();
	const skillKey = (_splat ?? "").split("/").map(decodeResourceRouteParam).join("/");
	const projectId = typeof search.project === "string" ? search.project : null;
	return (
		<AgentResourceRouteGate
			agentId={id}
			returnHref={agentSectionHref(id, "projects", agentDeploymentRouteQuery(search))}
			returnLabel="Agent Projects"
			projectAccess={{ projectId }}
		>
			<SkillDetailContent agentId={id} skillKey={skillKey} routeSearch={search} />
		</AgentResourceRouteGate>
	);
}
