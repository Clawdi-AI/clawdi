import { createFileRoute } from "@tanstack/react-router";
import { agentFileHeaders } from "@/lib/agent-file-headers";
import { AGENT_FILES } from "@/lib/agent-files";
import { agentSetupPrompt } from "@/lib/agent-setup-prompt";
import { publicSiteOrigin } from "@/lib/public-site";

export function GET({ request }: { request: Request }): Response {
	return new Response(agentSetupPrompt(publicSiteOrigin(new URL(request.url).origin)), {
		headers: agentFileHeaders(AGENT_FILES.setupPrompt),
	});
}

export const Route = createFileRoute("/agent-setup-prompt.txt")({
	server: { handlers: { GET } },
});
