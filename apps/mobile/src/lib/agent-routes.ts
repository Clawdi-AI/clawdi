import type { MobileAgentSection } from "@clawdi/shared/view";

// Keep these segments identical to apps/web/src/lib/agent-routes.ts.
const AGENT_SECTION_SEGMENTS = {
	overview: "",
	sessions: "sessions",
	memories: "memories",
	skills: "skills",
	projects: "project-access",
	vaults: "vaults",
	console: "console",
	files: "files",
	terminal: "terminal",
	connectors: "connectors",
	ai: "model-provider",
	channels: "channel-links",
	plugins: "plugins",
	settings: "settings",
} as const;
export type AgentSectionId = keyof typeof AGENT_SECTION_SEGMENTS;

export function parseAgentSectionSegment(value: string): AgentSectionId | undefined {
	return (Object.keys(AGENT_SECTION_SEGMENTS) as AgentSectionId[]).find(
		(key) => AGENT_SECTION_SEGMENTS[key] === value,
	);
}
export function agentSectionHref(
	id: string,
	section: AgentSectionId | MobileAgentSection = "overview",
) {
	const segment = AGENT_SECTION_SEGMENTS[section];
	return `/agents/${encodeURIComponent(id)}${segment ? `/${segment}` : ""}` as const;
}
