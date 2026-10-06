import { createFileRoute } from "@tanstack/react-router";
import { agentFileHeaders } from "@/lib/agent-file-headers";
import { AGENT_FILES } from "@/lib/agent-files";
import { publicSiteOrigin } from "@/lib/public-site";

export function GET({ request }: { request: Request }): Response {
	const origin = publicSiteOrigin(new URL(request.url).origin);
	const headers = agentFileHeaders(AGENT_FILES.legacyGuide);
	headers.set("Location", new URL(AGENT_FILES.getStarted.path, origin).href);
	return new Response(null, { status: 301, headers });
}

export const Route = createFileRoute("/skill.md")({
	server: { handlers: { GET } },
});
