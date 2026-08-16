import { createFileRoute, redirect } from "@tanstack/react-router";
import { agentSectionLink } from "@/lib/agent-routes";
import { routeHeadTitle } from "@/lib/document-title";
import { AgentDetailClient } from "@/pages/dashboard/agents/agent-detail-client";

const IS_HOSTED_BUILD = import.meta.env.VITE_CLAWDI_HOSTED === "true";

export const Route = createFileRoute("/_protected/_dashboard/agents/$id/plugins/$pluginName")({
	beforeLoad: ({ params, search }) => {
		if (!IS_HOSTED_BUILD) {
			throw redirect({ ...agentSectionLink(params.id, "overview", search), replace: true });
		}
	},
	head: () => routeHeadTitle("Plugin"),
	component: AgentPluginDetailRoute,
});

function AgentPluginDetailRoute() {
	const { id, pluginName } = Route.useParams();
	const search = Route.useSearch();
	return (
		<AgentDetailClient
			environmentId={id}
			section="plugins"
			routeSearch={search}
			pluginName={pluginName}
		/>
	);
}
