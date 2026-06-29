import { createFileRoute } from "@tanstack/react-router";
import ShareProjectPage from "@/pages/share/project-share-page";

export const Route = createFileRoute("/share/$token")({
	component: ShareProjectRoute,
});

function ShareProjectRoute() {
	const { token } = Route.useParams();
	return <ShareProjectPage token={token} />;
}
