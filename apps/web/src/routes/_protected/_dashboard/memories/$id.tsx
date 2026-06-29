import { createFileRoute } from "@tanstack/react-router";
import MemoryDetailPage from "@/pages/dashboard/memories/[id]/page";

export const Route = createFileRoute("/_protected/_dashboard/memories/$id")({
	component: MemoryDetailRoute,
});

function MemoryDetailRoute() {
	const { id } = Route.useParams();
	return <MemoryDetailPage memoryId={id} />;
}
