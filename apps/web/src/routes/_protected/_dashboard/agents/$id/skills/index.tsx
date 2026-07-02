import { createFileRoute, redirect } from "@tanstack/react-router";
import { agentSectionHref, hasAgentTabQuery } from "@/lib/agent-routes";
import { AgentDetailClient } from "@/pages/dashboard/agents/agent-detail-client";

// Explicit index route for the agent Skills tab. Without it the bare
// `/agents/<id>/skills` URL falls through to the sibling splat route
// (`skills/$` outranks `$section` because its static `skills` segment
// beats the dynamic one, and a splat also matches the empty path), so
// the tab rendered the skill DETAIL page with an empty key — which
// fired `GET /v1/skills/` and 422'd.
export const Route = createFileRoute("/_protected/_dashboard/agents/$id/skills/")({
	beforeLoad: ({ params, search }) => {
		// Mirror `$section`'s legacy `?tab=` redirect: this URL no longer
		// reaches `$section`, so old tab-query links normalize here.
		if (hasAgentTabQuery(search)) {
			throw redirect({ href: agentSectionHref(params.id, "skills", search), replace: true });
		}
	},
	component: AgentSkillsRoute,
});

function AgentSkillsRoute() {
	const { id } = Route.useParams();
	return <AgentDetailClient environmentId={id} section="skills" />;
}
