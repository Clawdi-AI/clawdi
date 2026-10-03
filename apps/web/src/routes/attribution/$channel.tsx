import { createFileRoute } from "@tanstack/react-router";
import { captureChannelAttribution } from "@/lib/channel-attribution.server";

export const Route = createFileRoute("/attribution/$channel")({
	server: {
		handlers: {
			GET: ({ request, params }) => captureChannelAttribution(request, params.channel),
		},
	},
});
