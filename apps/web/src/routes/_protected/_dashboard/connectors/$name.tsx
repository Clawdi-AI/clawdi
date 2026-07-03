import { createFileRoute } from "@tanstack/react-router";
import { routeHeadTitle } from "@/lib/document-title";
import ConnectorDetailPage from "@/pages/dashboard/connectors/[name]/page";

export const Route = createFileRoute("/_protected/_dashboard/connectors/$name")({
	head: () => routeHeadTitle("Connector"),
	component: ConnectorDetailRoute,
});

function ConnectorDetailRoute() {
	const { name } = Route.useParams();
	return <ConnectorDetailPage name={name} />;
}
