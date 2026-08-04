import { createFileRoute } from "@tanstack/react-router";
import { routeHeadTitle } from "@/lib/document-title";
import ConnectorDetailPage from "@/pages/dashboard/connectors/[name]/page";

export const Route = createFileRoute("/_protected/_dashboard/agents/$id/connectors/$name")({
	head: () => routeHeadTitle("Connector"),
	component: AgentConnectorDetailRoute,
});

function AgentConnectorDetailRoute() {
	const { name } = Route.useParams();
	return <ConnectorDetailPage name={name} />;
}
