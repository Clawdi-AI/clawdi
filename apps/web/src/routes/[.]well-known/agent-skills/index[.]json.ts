import { createFileRoute } from "@tanstack/react-router";
import { agentFileHeaders } from "@/lib/agent-file-headers";
import { AGENT_FILES } from "@/lib/agent-files";
import { agentSkillsIndex } from "@/lib/agent-skills";

export function GET(): Response {
	return new Response(JSON.stringify(agentSkillsIndex), {
		headers: agentFileHeaders(AGENT_FILES.discoveryIndex),
	});
}

export const Route = createFileRoute("/.well-known/agent-skills/index.json")({
	server: { handlers: { GET } },
});
