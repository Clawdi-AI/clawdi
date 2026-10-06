import { createFileRoute } from "@tanstack/react-router";
import guide from "@/content/get-started.md?raw";
import { agentFileHeaders } from "@/lib/agent-file-headers";
import { AGENT_FILES } from "@/lib/agent-files";
import { env } from "@/lib/env";

export function GET(): Response {
	return new Response(guide, {
		headers: agentFileHeaders(AGENT_FILES.getStarted, {
			canonical: env.VITE_CLAWDI_HOSTED
				? "https://docs.clawdi.ai/getting-started/connect-agents"
				: undefined,
		}),
	});
}

export const Route = createFileRoute("/get-started.md")({
	server: { handlers: { GET } },
});
