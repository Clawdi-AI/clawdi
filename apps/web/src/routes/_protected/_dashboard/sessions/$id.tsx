import { createFileRoute } from "@tanstack/react-router";
import { routeHeadTitle } from "@/lib/document-title";
import {
	sessionSearchAnchorFromSearch,
	validateSessionDetailSearch,
} from "@/lib/session-search-anchor";
import SessionDetailPage from "@/pages/dashboard/sessions/[id]/page";

export const Route = createFileRoute("/_protected/_dashboard/sessions/$id")({
	validateSearch: validateSessionDetailSearch,
	head: () => routeHeadTitle("Session"),
	component: SessionDetailRoute,
});

function SessionDetailRoute() {
	const { id } = Route.useParams();
	const search = Route.useSearch();
	const searchAnchor = sessionSearchAnchorFromSearch(search);
	return (
		<SessionDetailPage sessionId={id} searchAnchor={searchAnchor} returnTo={search.returnTo} />
	);
}
