import { createFileRoute } from "@tanstack/react-router";
import { routeHeadTitle } from "@/lib/document-title";
import ShareProjectPage from "@/pages/share/project-share-page";

export const Route = createFileRoute("/share/$token")({
	head: () => routeHeadTitle("Shared Project"),
	component: ShareProjectRoute,
});

function ShareProjectRoute() {
	const { token } = Route.useParams();
	return <ShareProjectPage token={token} />;
}
