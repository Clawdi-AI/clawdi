import { createFileRoute } from "@tanstack/react-router";
import ChannelsRoutePage from "@/app/(dashboard)/channels/page";

export const Route = createFileRoute("/_protected/_dashboard/channels/")({
	component: ChannelsRoutePage,
});
