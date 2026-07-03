import { createFileRoute } from "@tanstack/react-router";
import { routeHeadTitle } from "@/lib/document-title";
import ChannelsRoutePage from "@/pages/dashboard/channels/page";

export const Route = createFileRoute("/_protected/_dashboard/channels/")({
	head: () => routeHeadTitle("Channels"),
	component: ChannelsRoutePage,
});
