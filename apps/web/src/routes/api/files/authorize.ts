import { createFileRoute } from "@tanstack/react-router";
import { GET } from "@/pages/files/files-authorize-route";

export const Route = createFileRoute("/api/files/authorize")({
	server: {
		handlers: {
			GET: ({ request }) => GET(request),
		},
	},
});
