import { createFileRoute } from "@tanstack/react-router";
import { routeHeadTitle } from "@/lib/document-title";
import MemoryDetailPage from "@/pages/dashboard/memories/[id]/page";

export const Route = createFileRoute("/_protected/_dashboard/memories/$id")({
	head: () => routeHeadTitle("Memory"),
	component: MemoryDetailRoute,
});

function MemoryDetailRoute() {
	const { id } = Route.useParams();
	return <MemoryDetailPage memoryId={id} />;
}
