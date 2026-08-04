import { createFileRoute } from "@tanstack/react-router";
import { AgentResourceRouteGate } from "@/components/dashboard/agent-resource-route-gate";
import { agentSectionHref } from "@/lib/agent-routes";
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
	const scope = agentResourceScope(id, search);
	return (
		<AgentResourceRouteGate
			agentId={id}
			returnHref={agentSectionHref(id, "connectors", search)}
			returnLabel="Agent Connectors"
		>
			<ConnectorDetailPage name={name} scope={scope} />
		</AgentResourceRouteGate>
	);
}
