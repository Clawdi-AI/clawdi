export type AgentSectionId =
	| "overview"
	| "sessions"
	| "skills"
	| "projects"
	| "console"
	| "terminal"
	| "ai"
	| "channels"
	| "settings";

export type RouteSearchParamsRecord = Record<string, string | string[] | undefined>;
export type AgentRouteQuery = string | URLSearchParams | RouteSearchParamsRecord | null | undefined;

export const CONNECTED_AGENT_SECTION_IDS = [
	"overview",
	"sessions",
	"skills",
	"projects",
	"settings",
] as const satisfies readonly AgentSectionId[];

export const HOSTED_AGENT_SECTION_IDS = [
	"overview",
	"console",
	"terminal",
	"sessions",
	"ai",
	"channels",
	"settings",
] as const satisfies readonly AgentSectionId[];

const AGENT_SECTION_SEGMENTS = {
	overview: "",
	sessions: "sessions",
	skills: "skills",
	projects: "project-access",
	console: "console",
	terminal: "terminal",
	ai: "model-provider",
	channels: "channel-links",
	settings: "settings",
} as const satisfies Record<AgentSectionId, string>;

const AGENT_SECTION_LABELS = {
	overview: "Overview",
	sessions: "Sessions",
	skills: "Skills",
	projects: "Project Access",
	console: "Runtime Console",
	terminal: "Terminal",
	ai: "Model Provider",
	channels: "Channel Links",
	settings: "Settings",
} as const satisfies Record<AgentSectionId, string>;

const AGENT_SEGMENT_TO_SECTION = Object.fromEntries(
	Object.entries(AGENT_SECTION_SEGMENTS)
		.filter(([, segment]) => segment)
		.map(([section, segment]) => [segment, section]),
) as Record<string, AgentSectionId>;

export type ParsedAgentPathname = {
	agentId: string;
	section: AgentSectionId;
	sessionId?: string;
	skillKey?: string;
};

export function agentSectionSegment(section: AgentSectionId): string {
	return AGENT_SECTION_SEGMENTS[section];
}

export function agentSectionLabel(section: AgentSectionId): string {
	return AGENT_SECTION_LABELS[section];
}

export function agentSectionLabelFromSegment(segment: string): string | null {
	const section = parseAgentSectionSegment(segment);
	if (!section) return null;
	return agentSectionLabel(section);
}

export function parseAgentSectionSegment(value: string | null | undefined): AgentSectionId | null {
	if (!value) return "overview";
	return AGENT_SEGMENT_TO_SECTION[value] ?? null;
}

export function parseAgentPathname(pathname: string): ParsedAgentPathname | null {
	const [path] = pathname.split("?");
	const parts = path.split("/").filter(Boolean);
	if (parts[0] !== "agents" || !parts[1]) return null;

	const agentId = safeDecodeURIComponent(parts[1]);
	const section = parseAgentSectionSegment(safeDecodeURIComponent(parts[2] ?? ""));
	if (!section) return null;
	const sessionId =
		section === "sessions" && parts[3] ? safeDecodeURIComponent(parts[3]) : undefined;
	const skillKey =
		section === "skills" && parts[3]
			? parts.slice(3).map(safeDecodeURIComponent).join("/")
			: undefined;
	return { agentId, section, sessionId, skillKey };
}

function agentRouteSearchParams(query?: AgentRouteQuery): URLSearchParams {
	if (!query) return new URLSearchParams();
	if (typeof query === "string" || query instanceof URLSearchParams) {
		return new URLSearchParams(query.toString());
	}
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(query)) {
		if (value === undefined) continue;
		if (Array.isArray(value)) {
			for (const item of value) params.append(key, item);
			continue;
		}
		params.set(key, value);
	}
	return params;
}

export function hasAgentTabQuery(query?: AgentRouteQuery): boolean {
	return agentRouteSearchParams(query).has("tab");
}

export function agentRouteQueryString(query?: AgentRouteQuery): string {
	const params = agentRouteSearchParams(query);
	params.delete("tab");
	return params.toString();
}

export function agentSectionHref(
	agentId: string,
	section: AgentSectionId = "overview",
	query?: AgentRouteQuery,
): string {
	const encodedAgentId = encodeURIComponent(agentId);
	const segment = agentSectionSegment(section);
	const path = segment ? `/agents/${encodedAgentId}/${segment}` : `/agents/${encodedAgentId}`;
	const queryString = agentRouteQueryString(query);
	return queryString ? `${path}?${queryString}` : path;
}

export function agentSessionDetailHref(agentId: string, sessionId: string): string {
	return `${agentSectionHref(agentId, "sessions")}/${encodeURIComponent(sessionId)}`;
}

export function agentSkillDetailHref(
	agentId: string,
	skillKey: string,
	projectId?: string | null,
): string {
	const encodedSkillPath = skillKey.split("/").map(encodeURIComponent).join("/");
	const path = `${agentSectionHref(agentId, "skills")}/${encodedSkillPath}`;
	return projectId ? `${path}?project=${encodeURIComponent(projectId)}` : path;
}

function safeDecodeURIComponent(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}
