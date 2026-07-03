import { createFileRoute } from "@tanstack/react-router";
import { routeHeadTitle } from "@/lib/document-title";
import ChannelRoutePage from "@/pages/dashboard/channels/[id]/page";

export const Route = createFileRoute("/_protected/_dashboard/channels/$id")({
	head: () => routeHeadTitle("Channel"),
	component: ChannelDetailRoute,
});

function ChannelDetailRoute() {
	const { id } = Route.useParams();
	return <ChannelRoutePage channelId={id} />;
}
