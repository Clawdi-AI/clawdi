import { createFileRoute } from "@tanstack/react-router";
import ConnectorsPage from "@/app/(dashboard)/connectors/page";

export const Route = createFileRoute("/_protected/_dashboard/connectors/")({
	component: ConnectorsPage,
});
