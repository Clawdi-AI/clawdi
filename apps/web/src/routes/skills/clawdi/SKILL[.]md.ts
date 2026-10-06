import { createFileRoute } from "@tanstack/react-router";
import { agentFileHeaders } from "@/lib/agent-file-headers";
import { AGENT_FILES } from "@/lib/agent-files";
import { clawdiSkill } from "@/lib/agent-skills";

export function GET(): Response {
	return new Response(clawdiSkill, {
		headers: agentFileHeaders(AGENT_FILES.skill),
	});
}

export const Route = createFileRoute("/skills/clawdi/SKILL.md")({
	server: { handlers: { GET } },
});
