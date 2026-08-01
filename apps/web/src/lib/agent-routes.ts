import { defaultParseSearch, defaultStringifySearch, linkOptions } from "@tanstack/react-router";
import type { AgentSectionId } from "@/lib/navigation-model";
import { AGENT_SECTION_NAVIGATION_ITEMS } from "@/lib/navigation-model";

export type { AgentSectionId } from "@/lib/navigation-model";
export { CONNECTED_AGENT_SECTION_IDS, HOSTED_AGENT_SECTION_IDS } from "@/lib/navigation-model";

export type RouteSearchParamsRecord = Record<string, string | string[] | undefined>;
export type AgentRouteSearch = Record<string, unknown> & {
	source?: string;
	d?: string;
	tab?: string;
	project?: string;
};
export type AgentRouteQuery =
	| string
	| URLSearchParams
	| RouteSearchParamsRecord
	| AgentRouteSearch
	| null
	| undefined;

export const AGENT_DEPLOYMENT_SELECTOR_QUERY_KEY = "d";

const AGENT_SECTION_SEGMENTS = {
	overview: "",
	sessions: "sessions",
	skills: "skills",
	projects: "project-access",
	vaults: "vaults",
	console: "console",
	terminal: "terminal",
	connectors: "connectors",
	ai: "model-provider",
	channels: "channel-links",
	settings: "settings",
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
	return AGENT_SECTION_NAVIGATION_ITEMS[section].label;
}

export function agentSectionLabelFromSegment(segment: string): string | null {
	const section = parseAgentSectionSegment(segment);
	if (!section) return null;
	return agentSectionLabel(section);
}

export function parseAgentSectionSegment(value: string | null | undefined): AgentSectionId | null {
	if (!value) return "overview";
	return AGENT_SEGMENT_TO_SECTION[value.toLowerCase()] ?? null;
}

export function parseAgentPathname(pathname: string): ParsedAgentPathname | null {
	const [path] = pathname.split("?");
	const parts = path.split("/").filter(Boolean);
	if (parts[0]?.toLowerCase() !== "agents" || !parts[1]) return null;

	const agentId = safeDecodeURIComponent(parts[1]);
	const section = parseAgentSectionSegment(safeDecodeURIComponent(parts[2] ?? ""));
	if (!section) return null;
	if (section === "overview" && parts.length !== 2) return null;
	if (section === "sessions" && parts.length > 4) return null;
	if (
		section !== "overview" &&
		section !== "sessions" &&
		section !== "skills" &&
		parts.length !== 3
	) {
		return null;
	}
	const sessionId =
		section === "sessions" && parts[3] ? safeDecodeURIComponent(parts[3]) : undefined;
	const skillKey =
		section === "skills" && parts[3]
			? parts.slice(3).map(safeDecodeURIComponent).join("/")
			: undefined;
	return { agentId, section, sessionId, skillKey };
}

/**
 * TanStack Router is case-insensitive by default (`caseSensitive: false`).
 * Route ownership comparisons follow that installed-router contract while API
 * values keep their original spelling.
 */
export function agentRouteIdsEqual(
	left: string | null | undefined,
	right: string | null | undefined,
) {
	return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}

/** A section component owns only its exact root route, never a nested detail route. */
export function agentRouteOwnsSection(
	pathname: string,
	agentId: string,
	section: AgentSectionId,
): boolean {
	const route = parseAgentPathname(pathname);
	return (
		Boolean(route) &&
		agentRouteIdsEqual(route?.agentId, agentId) &&
		route?.section === section &&
		!route.sessionId &&
		!route.skillKey
	);
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
			for (const item of value) {
				if (typeof item === "string") params.append(key, item);
			}
			continue;
		}
		if (typeof value === "string") params.set(key, value);
	}
	return params;
}

function agentRouteSearch(query?: AgentRouteQuery): AgentRouteSearch | undefined {
	if (query && typeof query === "object" && !(query instanceof URLSearchParams)) {
		const search = { ...query };
		delete search.tab;
		return Object.keys(search).length > 0 ? search : undefined;
	}
	const params = agentRouteSearchParams(query);
	params.delete("tab");
	const search: AgentRouteSearch = defaultParseSearch(params.toString());
	return Object.keys(search).length > 0 ? search : undefined;
}

function optionalSearchString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/** Validate the shared agent-route search boundary while retaining additive query state. */
export function validateAgentRouteSearch(search: Record<string, unknown>): AgentRouteSearch {
	return {
		...search,
		source: optionalSearchString(search.source),
		d: optionalSearchString(search.d),
		tab: optionalSearchString(search.tab),
		project: optionalSearchString(search.project),
	};
}

const LEGACY_AGENT_TAB_SECTIONS: Readonly<Record<string, AgentSectionId>> = {
	overview: "overview",
	sessions: "sessions",
	skills: "skills",
	projects: "projects",
	"project-access": "projects",
	vaults: "vaults",
	console: "console",
	terminal: "terminal",
	connectors: "connectors",
	ai: "ai",
	"model-provider": "ai",
	channels: "channels",
	"channel-links": "channels",
	settings: "settings",
	compute: "settings",
};

export function legacyAgentRoute(
	fallbackSection: AgentSectionId,
	search: AgentRouteSearch,
): { section: AgentSectionId; search?: AgentRouteSearch } | null {
	if (typeof search.tab !== "string") return null;
	const legacyTab = search.tab.trim().toLowerCase();
	const section = LEGACY_AGENT_TAB_SECTIONS[legacyTab] ?? fallbackSection;
	const nextSearch = { ...search };
	delete nextSearch.tab;
	return {
		section,
		search: Object.keys(nextSearch).length > 0 ? nextSearch : undefined,
	};
}

export function agentDeploymentSelector(query?: AgentRouteQuery): string | null {
	const selector = agentRouteSearchParams(query).get(AGENT_DEPLOYMENT_SELECTOR_QUERY_KEY)?.trim();
	return selector || null;
}

export function agentDeploymentRouteQuery(
	query?: AgentRouteQuery,
): RouteSearchParamsRecord | undefined {
	const params = agentRouteSearchParams(query);
	const selector = agentDeploymentSelector(params);
	if (!selector) return undefined;
	return {
		source: params.get("source") || undefined,
		[AGENT_DEPLOYMENT_SELECTOR_QUERY_KEY]: selector,
	};
}

export function agentRouteQueryString(query?: AgentRouteQuery): string {
	if (query && typeof query === "object" && !(query instanceof URLSearchParams)) {
		return defaultStringifySearch(agentRouteSearch(query) ?? {})
			.slice(1)
			.replace(/\+/g, "%20");
	}
	const params = agentRouteSearchParams(query);
	params.delete("tab");
	return params.toString().replace(/\+/g, "%20");
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

/** Typed TanStack Router options for canonical agent section navigation. */
export function agentSectionLink(
	agentId: string,
	section: AgentSectionId = "overview",
	query?: AgentRouteQuery,
) {
	const search = agentRouteSearch(query);
	if (section === "overview") {
		return linkOptions({ to: "/agents/$id", params: { id: agentId }, search });
	}
	if (section === "skills") {
		return linkOptions({ to: "/agents/$id/skills", params: { id: agentId }, search });
	}
	return linkOptions({
		to: "/agents/$id/$section",
		params: { id: agentId, section: agentSectionSegment(section) },
		search,
	});
}

export function bindAgentDeploymentSearch(
	search: AgentRouteSearch,
	deploymentId: string,
): AgentRouteSearch {
	return {
		...search,
		source: "on-clawdi",
		[AGENT_DEPLOYMENT_SELECTOR_QUERY_KEY]: deploymentId,
	};
}

function agentDetailHref(path: string, query?: AgentRouteQuery): string {
	const queryString = agentRouteQueryString(query);
	return queryString ? `${path}?${queryString}` : path;
}

export function agentSessionDetailHref(
	agentId: string,
	sessionId: string,
	query?: AgentRouteQuery,
): string {
	const path = `${agentSectionHref(agentId, "sessions")}/${encodeURIComponent(sessionId)}`;
	return agentDetailHref(path, query);
}

/** Typed TanStack Router options for an agent-scoped session detail link. */
export function agentSessionDetailLink(
	agentId: string,
	sessionId: string,
	query?: AgentRouteQuery,
) {
	return linkOptions({
		to: "/agents/$id/sessions/$sessionId",
		params: { id: agentId, sessionId },
		search: agentRouteSearch(query),
	});
}

export function agentSkillDetailHref(
	agentId: string,
	skillKey: string,
	projectId?: string | null,
	query?: AgentRouteQuery,
): string {
	const encodedSkillPath = skillKey.split("/").map(encodeURIComponent).join("/");
	const path = `${agentSectionHref(agentId, "skills")}/${encodedSkillPath}`;
	const search = agentRouteSearch(query) ?? {};
	if (projectId) search.project = projectId;
	return agentDetailHref(path, search);
}

/** Typed TanStack Router options for an agent-scoped skill detail link. */
export function agentSkillDetailLink(
	agentId: string,
	skillKey: string,
	projectId?: string | null,
	query?: AgentRouteQuery,
) {
	const search = agentRouteSearch(query) ?? {};
	if (projectId) search.project = projectId;
	return linkOptions({
		to: "/agents/$id/skills/$",
		params: { id: agentId, _splat: skillKey },
		search: Object.keys(search).length > 0 ? search : undefined,
	});
}

function safeDecodeURIComponent(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}
