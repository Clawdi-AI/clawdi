import { createFileRoute } from "@tanstack/react-router";
import { GET } from "@/app/s/[id]/[format]/route";

export const Route = createFileRoute("/s/{$id}.md")({
	server: {
		handlers: {
			GET: ({ request, params }) =>
				GET(request, { params: Promise.resolve({ id: params.id, format: "md" }) }),
		},
	},
});
