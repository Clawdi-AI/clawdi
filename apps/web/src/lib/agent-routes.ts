import { defaultStringifySearch, linkOptions } from "@tanstack/react-router";
import type { AgentSectionId } from "@/lib/navigation-model";
import { AGENT_SECTION_NAVIGATION_ITEMS } from "@/lib/navigation-model";

export type { AgentSectionId } from "@/lib/navigation-model";
export { CONNECTED_AGENT_SECTION_IDS, HOSTED_AGENT_SECTION_IDS } from "@/lib/navigation-model";

export type AgentRouteSearch = Record<string, unknown> & {
	tab?: string;
	project?: string;
	vault?: string;
	subscription_action?: "start_new";
};

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
	projectId?: string;
	projectResource?: AgentProjectResourceSection;
	vaultSlug?: string;
	memoryId?: string;
	connectorName?: string;
	pluginName?: string;
};

export type AgentProjectResourceSection = "skills" | "vaults";

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
		!["sessions", "skills", "projects", "vaults", "memories", "connectors", "plugins"].includes(
			section,
		)
	) {
		if (parts.length !== 3) return null;
	}
	if (["vaults", "memories", "connectors", "plugins"].includes(section) && parts.length > 4)
		return null;
	if (section === "projects" && parts.length > 5) return null;
	const sessionId =
		section === "sessions" && parts[3] ? safeDecodeURIComponent(parts[3]) : undefined;
	const skillKey =
		section === "skills" && parts[3]
			? parts.slice(3).map(safeDecodeURIComponent).join("/")
			: undefined;
	const projectId =
		section === "projects" && parts[3] ? safeDecodeURIComponent(parts[3]) : undefined;
	const projectResource =
		section === "projects" && parts[4] && (parts[4] === "skills" || parts[4] === "vaults")
			? parts[4]
			: undefined;
	if (section === "projects" && parts[4] && !projectResource) return null;
	const vaultSlug = section === "vaults" && parts[3] ? safeDecodeURIComponent(parts[3]) : undefined;
	const memoryId =
		section === "memories" && parts[3] ? safeDecodeURIComponent(parts[3]) : undefined;
	const connectorName =
		section === "connectors" && parts[3] ? safeDecodeURIComponent(parts[3]) : undefined;
	const pluginName =
		section === "plugins" && parts[3] ? safeDecodeURIComponent(parts[3]) : undefined;
	return {
		agentId,
		section,
		sessionId,
		skillKey,
		...(projectId ? { projectId } : {}),
		...(projectResource ? { projectResource } : {}),
		...(vaultSlug ? { vaultSlug } : {}),
		...(memoryId ? { memoryId } : {}),
		...(connectorName ? { connectorName } : {}),
		...(pluginName ? { pluginName } : {}),
	};
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
		!route.skillKey &&
		!route.projectId &&
		!route.projectResource &&
		!route.vaultSlug &&
		!route.memoryId &&
		!route.connectorName &&
		!route.pluginName
	);
}

function optionalSearchString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function subscriptionAction(value: unknown): AgentRouteSearch["subscription_action"] {
	return value === "start_new" ? value : undefined;
}

/** Validate the shared agent-route search boundary while retaining additive query state. */
export function validateAgentRouteSearch(search: Record<string, unknown>): AgentRouteSearch {
	const validated: AgentRouteSearch = { ...search };
	for (const key of ["tab", "project", "vault"] as const) {
		const value = optionalSearchString(search[key]);
		if (value === undefined) delete validated[key];
		else validated[key] = value;
	}
	const action = subscriptionAction(search.subscription_action);
	if (action === undefined) delete validated.subscription_action;
	else validated.subscription_action = action;
	delete validated.source;
	delete validated.d;
	return validated;
}

const LEGACY_AGENT_TAB_SECTIONS: Readonly<Record<string, AgentSectionId>> = {
	overview: "overview",
	sessions: "sessions",
	memories: "memories",
	skills: "skills",
	projects: "projects",
	"project-access": "projects",
	vaults: "vaults",
	console: "console",
	files: "files",
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

function routeSearchQueryString(search?: AgentRouteSearch): string {
	return search ? defaultStringifySearch(search).slice(1).replace(/\+/g, "%20") : "";
}

export function agentSectionHref(
	agentId: string,
	section: AgentSectionId = "overview",
	search?: AgentRouteSearch,
): string {
	const encodedAgentId = encodeURIComponent(agentId);
	const segment = agentSectionSegment(section);
	const path = segment ? `/agents/${encodedAgentId}/${segment}` : `/agents/${encodedAgentId}`;
	const queryString = routeSearchQueryString(search);
	return queryString ? `${path}?${queryString}` : path;
}

/** Typed TanStack Router options for canonical agent section navigation. */
export function agentSectionLink(
	agentId: string,
	section: AgentSectionId = "overview",
	search?: AgentRouteSearch,
) {
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

function agentDetailHref(path: string, search?: AgentRouteSearch): string {
	const queryString = routeSearchQueryString(search);
	return queryString ? `${path}?${queryString}` : path;
}

export function agentSessionDetailHref(agentId: string, sessionId: string): string {
	return `${agentSectionHref(agentId, "sessions")}/${encodeURIComponent(sessionId)}`;
}

/** Typed TanStack Router options for an agent-scoped session detail link. */
export function agentSessionDetailLink(agentId: string, sessionId: string) {
	return linkOptions({
		to: "/agents/$id/sessions/$sessionId",
		params: { id: agentId, sessionId },
	});
}

export function agentSkillDetailHref(
	agentId: string,
	skillKey: string,
	projectId?: string | null,
): string {
	const encodedSkillPath = skillKey.split("/").map(encodeURIComponent).join("/");
	const path = `${agentSectionHref(agentId, "skills")}/${encodedSkillPath}`;
	return agentDetailHref(path, projectId ? { project: projectId } : undefined);
}

/** Typed TanStack Router options for an agent-scoped skill detail link. */
export function agentSkillDetailLink(agentId: string, skillKey: string, projectId?: string | null) {
	return linkOptions({
		to: "/agents/$id/skills/$",
		params: { id: agentId, _splat: skillKey },
		search: projectId ? { project: projectId } : undefined,
	});
}

export function agentProjectDetailHref(agentId: string, projectId: string): string {
	return `${agentSectionHref(agentId, "projects")}/${encodeURIComponent(projectId)}`;
}

export function agentProjectResourceHref(
	agentId: string,
	projectId: string,
	resource: AgentProjectResourceSection,
): string {
	return `${agentSectionHref(agentId, "projects")}/${encodeURIComponent(projectId)}/${resource}`;
}

/** Typed TanStack Router options for an agent-scoped Project detail link. */
export function agentProjectDetailLink(agentId: string, projectId: string) {
	return linkOptions({
		to: "/agents/$id/project-access/$projectId",
		params: { id: agentId, projectId },
	});
}

/** Typed TanStack Router options for a Project-scoped Agent resource collection. */
export function agentProjectResourceLink(
	agentId: string,
	projectId: string,
	resource: AgentProjectResourceSection,
) {
	const options = {
		params: { id: agentId, projectId },
	};
	return resource === "skills"
		? linkOptions({ ...options, to: "/agents/$id/project-access/$projectId/skills" })
		: linkOptions({ ...options, to: "/agents/$id/project-access/$projectId/vaults" });
}

export type AgentVaultDetailOptions = {
	projectId?: string | null;
	vaultId?: string | null;
};

function agentVaultDetailSearch({
	projectId,
	vaultId,
}: AgentVaultDetailOptions): AgentRouteSearch | undefined {
	if (!projectId && !vaultId) return undefined;
	return {
		...(projectId ? { project: projectId } : {}),
		...(vaultId ? { vault: vaultId } : {}),
	};
}

export function agentVaultDetailHref(
	agentId: string,
	vaultSlug: string,
	options: AgentVaultDetailOptions = {},
): string {
	const path = `${agentSectionHref(agentId, "vaults")}/${encodeURIComponent(vaultSlug)}`;
	return agentDetailHref(path, agentVaultDetailSearch(options));
}

/** Typed TanStack Router options for an agent-scoped Vault detail link. */
export function agentVaultDetailLink(
	agentId: string,
	vaultSlug: string,
	options: AgentVaultDetailOptions = {},
) {
	return linkOptions({
		to: "/agents/$id/vaults/$slug",
		params: { id: agentId, slug: vaultSlug },
		search: agentVaultDetailSearch(options),
	});
}

export function agentMemoryDetailHref(agentId: string, memoryId: string): string {
	return `${agentSectionHref(agentId, "memories")}/${encodeURIComponent(memoryId)}`;
}

/** Typed TanStack Router options for a Memory viewed in the Agent shell. */
export function agentMemoryDetailLink(agentId: string, memoryId: string) {
	return linkOptions({
		to: "/agents/$id/memories/$memoryId",
		params: { id: agentId, memoryId },
	});
}

export function agentConnectorDetailHref(agentId: string, connectorName: string): string {
	return `${agentSectionHref(agentId, "connectors")}/${encodeURIComponent(connectorName)}`;
}

/** Typed TanStack Router options for a Connector viewed in the Agent shell. */
export function agentConnectorDetailLink(agentId: string, connectorName: string) {
	return linkOptions({
		to: "/agents/$id/connectors/$name",
		params: { id: agentId, name: connectorName },
	});
}

export function agentPluginDetailHref(agentId: string, pluginName: string): string {
	return `${agentSectionHref(agentId, "plugins")}/${encodeURIComponent(pluginName)}`;
}

function safeDecodeURIComponent(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

const AGENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isAgentRouteId(value: string): boolean {
	return AGENT_ID_RE.test(value);
}
