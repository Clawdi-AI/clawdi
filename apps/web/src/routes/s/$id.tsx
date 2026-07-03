import { createFileRoute } from "@tanstack/react-router";
import { routeHeadTitle } from "@/lib/document-title";
import PublicSharePage from "@/pages/public-share/session-page";

export const Route = createFileRoute("/s/$id")({
	head: () => routeHeadTitle("Shared Session"),
	component: PublicShareRoute,
});

function PublicShareRoute() {
	const { id } = Route.useParams();
	return <PublicSharePage id={id} />;
}
