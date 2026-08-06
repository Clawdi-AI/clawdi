import { createFileRoute } from "@tanstack/react-router";
import { GET } from "@/pages/files/files-forward-auth-route";

export const Route = createFileRoute("/api/files/forward-auth")({
	server: {
		handlers: {
			GET: ({ request }) => GET(request),
		},
	},
});
