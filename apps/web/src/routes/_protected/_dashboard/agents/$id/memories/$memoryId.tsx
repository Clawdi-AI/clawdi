import { createFileRoute } from "@tanstack/react-router";
import { AgentResourceRouteGate } from "@/components/dashboard/agent-resource-route-gate";
import { agentSectionHref } from "@/lib/agent-routes";
import { routeHeadTitle } from "@/lib/document-title";
import { agentResourceScope } from "@/lib/resource-navigation";
import MemoryDetailPage from "@/pages/dashboard/memories/[id]/page";

export const Route = createFileRoute("/_protected/_dashboard/agents/$id/memories/$memoryId")({
	head: () => routeHeadTitle("Memory"),
	component: AgentMemoryDetailRoute,
});

function AgentMemoryDetailRoute() {
	const { id, memoryId } = Route.useParams();
	const search = Route.useSearch();
	const scope = agentResourceScope(id, search);
	return (
		<AgentResourceRouteGate
			agentId={id}
			returnHref={agentSectionHref(id, "memories", search)}
			returnLabel="Agent Memories"
		>
			<MemoryDetailPage memoryId={memoryId} scope={scope} />
		</AgentResourceRouteGate>
	);
}
