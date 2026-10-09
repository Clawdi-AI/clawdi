export const AGENT_SECTION_SEGMENTS = {
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

const AGENT_SEGMENT_TO_SECTION = new Map<string, AgentSectionId>(
	(Object.keys(AGENT_SECTION_SEGMENTS) as AgentSectionId[]).map((section) => [
		AGENT_SECTION_SEGMENTS[section],
		section,
	]),
);

export function agentSectionSegment(section: AgentSectionId): string {
	return AGENT_SECTION_SEGMENTS[section];
}

export function parseAgentSectionSegment(value: string | null | undefined): AgentSectionId | null {
	return AGENT_SEGMENT_TO_SECTION.get(value?.toLowerCase() ?? "") ?? null;
}

export function agentSectionHref(agentId: string, section: AgentSectionId = "overview") {
	const segment = AGENT_SECTION_SEGMENTS[section];
	return `/agents/${encodeURIComponent(agentId)}${segment ? `/${segment}` : ""}` as const;
}
