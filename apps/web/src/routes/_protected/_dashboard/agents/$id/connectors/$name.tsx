import { createFileRoute } from "@tanstack/react-router";
import { routeHeadTitle } from "@/lib/document-title";
import { agentResourceScope } from "@/lib/resource-navigation";
import ConnectorDetailPage from "@/pages/dashboard/connectors/[name]/page";

export const Route = createFileRoute("/_protected/_dashboard/agents/$id/connectors/$name")({
	head: () => routeHeadTitle("Connector"),
	component: AgentConnectorDetailRoute,
});

function AgentConnectorDetailRoute() {
	const { id, name } = Route.useParams();
	const search = Route.useSearch();
	return <ConnectorDetailPage name={name} scope={agentResourceScope(id, search)} />;
}
