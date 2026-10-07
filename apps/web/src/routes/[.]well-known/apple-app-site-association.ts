import { createFileRoute } from "@tanstack/react-router";
import { appleAppSiteAssociation } from "@/lib/app-links.server";

export function GET(): Response {
	return appleAppSiteAssociation();
}

export const Route = createFileRoute("/.well-known/apple-app-site-association")({
	server: { handlers: { GET } },
});
