import { createFileRoute } from "@tanstack/react-router";
import { routeHeadTitle } from "@/lib/document-title";
import SessionDetailPage from "@/pages/dashboard/sessions/[id]/page";

export const Route = createFileRoute("/_protected/_dashboard/sessions/$id")({
	head: () => routeHeadTitle("Session"),
	component: SessionDetailRoute,
});

function SessionDetailRoute() {
	const { id } = Route.useParams();
	return <SessionDetailPage sessionId={id} />;
}
