import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import {
	agentSectionLink,
	CONNECTED_AGENT_SECTION_IDS,
	parseAgentSectionSegment,
} from "@/lib/agent-routes";
import { routeHeadTitle } from "@/lib/document-title";
import { safeDecodeURIComponent } from "@/lib/url";
import { AgentDetailClient } from "@/pages/dashboard/agents/agent-detail-client";

const IS_HOSTED_BUILD = import.meta.env.VITE_CLAWDI_HOSTED === "true";

export const Route = createFileRoute("/_protected/_dashboard/agents/$id/$section")({
	head: () => routeHeadTitle("Agent"),
	beforeLoad: ({ params, search }) => {
		const section = parseAgentSectionSegment(safeDecodeURIComponent(params.section));
		if (!section || section === "overview") throw notFound();
		if (
			!IS_HOSTED_BUILD &&
			!CONNECTED_AGENT_SECTION_IDS.some((candidate) => candidate === section)
		) {
			throw redirect({ ...agentSectionLink(params.id, "overview", search), replace: true });
		}
		return { section };
	},
	component: AgentSectionRoute,
});

function AgentSectionRoute() {
	const { id } = Route.useParams();
	const { section } = Route.useRouteContext();
	const search = Route.useSearch();
	return <AgentDetailClient environmentId={id} section={section} routeSearch={search} />;
}
