import { createFileRoute } from "@tanstack/react-router";
import { agentFileHeaders } from "@/lib/agent-file-headers";
import { AGENT_FILES } from "@/lib/agent-files";
import { llmsTxt } from "@/lib/llms-txt";
import { publicSiteOrigin } from "@/lib/public-site";

export function GET({ request }: { request: Request }): Response {
	const instanceOrigin = new URL(request.url).origin;
	return new Response(llmsTxt(publicSiteOrigin(instanceOrigin), instanceOrigin), {
		headers: agentFileHeaders(AGENT_FILES.llms),
	});
}

export const Route = createFileRoute("/llms.txt")({
	server: { handlers: { GET } },
});
