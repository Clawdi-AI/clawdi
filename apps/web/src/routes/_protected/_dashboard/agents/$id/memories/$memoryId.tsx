import { createFileRoute } from "@tanstack/react-router";
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
	return <MemoryDetailPage memoryId={memoryId} scope={agentResourceScope(id, search)} />;
}
