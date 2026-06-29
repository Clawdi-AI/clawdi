import { createFileRoute } from "@tanstack/react-router";
import { GET } from "@/pages/public-share/session-export-route";

export const Route = createFileRoute("/s/{$id}.md")({
	server: {
		handlers: {
			GET: ({ request, params }) => GET(request, { id: params.id, format: "md" }),
		},
	},
});
