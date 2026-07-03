import { createFileRoute } from "@tanstack/react-router";
import { routeHeadTitle } from "@/lib/document-title";
import ConnectorsPage from "@/pages/dashboard/connectors/page";

export const Route = createFileRoute("/_protected/_dashboard/connectors/")({
	head: () => routeHeadTitle("Connectors"),
	component: ConnectorsPage,
});
