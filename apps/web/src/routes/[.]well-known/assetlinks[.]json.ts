import { createFileRoute } from "@tanstack/react-router";
import { androidAssetLinks } from "@/lib/app-links.server";

export function GET(): Response {
	return androidAssetLinks();
}

export const Route = createFileRoute("/.well-known/assetlinks.json")({
	server: { handlers: { GET } },
});
