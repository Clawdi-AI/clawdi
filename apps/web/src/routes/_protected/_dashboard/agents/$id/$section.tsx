import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { AgentDetailClient } from "@/app/(dashboard)/agents/[id]/agent-detail-client";
import { agentSectionHref, hasAgentTabQuery, parseAgentSectionSegment } from "@/lib/agent-routes";

function safeDecodeURIComponent(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

export const Route = createFileRoute("/_protected/_dashboard/agents/$id/$section")({
	beforeLoad: ({ params, search }) => {
		const section = parseAgentSectionSegment(safeDecodeURIComponent(params.section));
		if (!section || section === "overview") throw notFound();
		if (hasAgentTabQuery(search)) {
			throw redirect({ to: agentSectionHref(params.id, section, search), replace: true });
		}
		return { section };
	},
	component: AgentSectionRoute,
});

function AgentSectionRoute() {
	const { id } = Route.useParams();
	const { section } = Route.useRouteContext();
	return <AgentDetailClient environmentId={id} section={section} />;
}
