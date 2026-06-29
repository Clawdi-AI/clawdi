import { createFileRoute } from "@tanstack/react-router";
import SessionDetailPage from "@/pages/dashboard/sessions/[id]/page";

export const Route = createFileRoute("/_protected/_dashboard/sessions/$id")({
	component: SessionDetailRoute,
});

function SessionDetailRoute() {
	const { id } = Route.useParams();
	return <SessionDetailPage sessionId={id} />;
}
