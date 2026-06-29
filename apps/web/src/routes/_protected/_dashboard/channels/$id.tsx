import { createFileRoute } from "@tanstack/react-router";
import ChannelRoutePage from "@/app/(dashboard)/channels/[id]/page";

export const Route = createFileRoute("/_protected/_dashboard/channels/$id")({
	component: ChannelRoutePage,
});
