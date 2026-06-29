import { createFileRoute } from "@tanstack/react-router";
import ConnectorDetailPage from "@/app/(dashboard)/connectors/[name]/page";

export const Route = createFileRoute("/_protected/_dashboard/connectors/$name")({
	component: ConnectorDetailPage,
});
