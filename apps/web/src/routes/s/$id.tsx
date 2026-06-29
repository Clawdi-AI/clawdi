import { createFileRoute } from "@tanstack/react-router";
import PublicSharePage from "@/pages/public-share/session-page";

export const Route = createFileRoute("/s/$id")({
	component: PublicShareRoute,
});

function PublicShareRoute() {
	const { id } = Route.useParams();
	return <PublicSharePage id={id} />;
}
