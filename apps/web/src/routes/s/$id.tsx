import { createFileRoute } from "@tanstack/react-router";
import PublicSharePage from "@/app/s/[id]/page";

export const Route = createFileRoute("/s/$id")({
	component: PublicShareRoute,
});

function PublicShareRoute() {
	const { id } = Route.useParams();
	return <PublicSharePage params={Promise.resolve({ id })} />;
}
