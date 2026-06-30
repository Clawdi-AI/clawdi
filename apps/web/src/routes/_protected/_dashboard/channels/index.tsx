import { createFileRoute } from "@tanstack/react-router";
import ChannelsRoutePage from "@/pages/dashboard/channels/page";

export const Route = createFileRoute("/_protected/_dashboard/channels/")({
	component: ChannelsRoutePage,
});
