import { createFileRoute } from "@tanstack/react-router";
import { GET } from "@/app/s/[id]/[format]/route";

export const Route = createFileRoute("/s/{$id}.json")({
	server: {
		handlers: {
			GET: ({ request, params }) =>
				GET(request, { params: Promise.resolve({ id: params.id, format: "json" }) }),
		},
	},
});
