import { createFileRoute } from "@tanstack/react-router";
import ConnectorDetailPage from "@/pages/dashboard/connectors/[name]/page";

export const Route = createFileRoute("/_protected/_dashboard/connectors/$name")({
	component: ConnectorDetailRoute,
});

function ConnectorDetailRoute() {
	const { name } = Route.useParams();
	return <ConnectorDetailPage name={name} />;
}
