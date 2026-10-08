import type { DashboardStats } from "../api";

export type ProjectResourceId =
	| "projects"
	| "skills"
	| "vaults"
	| "sessions"
	| "memories"
	| "connectors";

export type ProjectResourceScope = "container" | "project-managed" | "activity" | "all-agents";
export type ProjectResourceGroup = "projects" | "library" | "activity";

export const PROJECT_RESOURCE_LIST_PATHS = {
	projects: "/projects",
	skills: "/skills",
	vaults: "/vaults",
	sessions: "/sessions",
	memories: "/memories",
	connectors: "/connectors",
} as const satisfies Record<ProjectResourceId, string>;

type DashboardStatCountKey = {
	[K in keyof DashboardStats]: DashboardStats[K] extends number ? K : never;
}[keyof DashboardStats];

export interface ProjectResourceDefinition {
	id: ProjectResourceId;
	label: string;
	singularLabel: string;
	navLabel: string;
	description: string;
	managementDescription: string;
	href: string;
	emptyCta: string;
	routeGroup: ProjectResourceGroup;
	projectScope: ProjectResourceScope;
	pathSegments: readonly string[];
	projectQueryParam?: "project";
	statsKey?: DashboardStatCountKey;
	countLabel?: string;
}

export const PROJECT_CANONICAL_DEFINITION = "A project groups skills and vaults for your agents.";

const PROJECT_RESOURCE_DEFINITIONS = [
	{
		id: "projects",
		label: "Projects",
		singularLabel: "Project",
		navLabel: "Projects",
		description: PROJECT_CANONICAL_DEFINITION,
		managementDescription:
			"Group skills and vaults into projects, then choose which agents use them.",
		href: PROJECT_RESOURCE_LIST_PATHS.projects,
		emptyCta: "Create project",
		routeGroup: "projects",
		projectScope: "container",
		pathSegments: ["Projects"],
		countLabel: "projects",
	},
	{
		id: "skills",
		label: "Skills",
		singularLabel: "Skill",
		navLabel: "Skills",
		description: "Reusable instructions that belong to a project.",
		managementDescription:
			"Skills belong to projects. Choose a project to add or change its skills; linked agents use the whole project.",
		href: PROJECT_RESOURCE_LIST_PATHS.skills,
		emptyCta: "Add skill",
		routeGroup: "library",
		projectScope: "project-managed",
		pathSegments: ["Projects", "Selected Project", "Skills"],
		projectQueryParam: "project",
		statsKey: "skills_count",
		countLabel: "skills",
	},
	{
		id: "vaults",
		label: "Vaults",
		singularLabel: "Vault",
		navLabel: "Vaults",
		description: "Encrypted key collections used by projects.",
		managementDescription:
			"Keep API keys in a vault, then add it to the projects where agents should use those keys.",
		href: PROJECT_RESOURCE_LIST_PATHS.vaults,
		emptyCta: "Create vault",
		routeGroup: "library",
		projectScope: "project-managed",
		pathSegments: ["Projects", "Selected Project", "Vaults"],
		projectQueryParam: "project",
		statsKey: "vault_count",
		countLabel: "vaults",
	},
	{
		id: "sessions",
		label: "Sessions",
		singularLabel: "Session",
		navLabel: "Sessions",
		description: "Conversation history synced from your agents.",
		managementDescription:
			"Sessions are agent activity. Browse conversations and filter by the agent that produced them.",
		href: PROJECT_RESOURCE_LIST_PATHS.sessions,
		emptyCta: "Start syncing",
		routeGroup: "activity",
		projectScope: "activity",
		pathSegments: ["Activity", "Sessions"],
		statsKey: "total_sessions",
		countLabel: "sessions",
	},
	{
		id: "memories",
		label: "Memories",
		singularLabel: "Memory",
		navLabel: "Memories",
		description: "Notes shared across all agents in this account.",
		managementDescription: "Memories are shared across all agents in this account.",
		href: PROJECT_RESOURCE_LIST_PATHS.memories,
		emptyCta: "Create memory",
		routeGroup: "activity",
		projectScope: "all-agents",
		pathSegments: ["Activity", "Memory"],
		statsKey: "memories_count",
		countLabel: "memories",
	},
	{
		id: "connectors",
		label: "Connectors",
		singularLabel: "Connector",
		navLabel: "Connectors",
		description: "App connections shared across all agents in this account.",
		managementDescription: "Connect apps once to share approved tools across all agents.",
		href: PROJECT_RESOURCE_LIST_PATHS.connectors,
		emptyCta: "Browse connectors",
		routeGroup: "library",
		projectScope: "all-agents",
		pathSegments: ["Library", "Connectors"],
		statsKey: "connectors_count",
		countLabel: "connectors",
	},
] as const satisfies readonly ProjectResourceDefinition[];

export function getProjectResourceDefinition(id: ProjectResourceId): ProjectResourceDefinition {
	const definition = PROJECT_RESOURCE_DEFINITIONS.find((resource) => resource.id === id);
	if (!definition) throw new Error(`Unknown project resource: ${id}`);
	return definition;
}

export function projectResourcePathLabel(
	resource: ProjectResourceDefinition,
	separator = " / ",
): string {
	return resource.pathSegments.join(separator);
}

export function projectResourceHref(id: ProjectResourceId, projectId?: string): string {
	const definition = getProjectResourceDefinition(id);
	if (!projectId || !definition.projectQueryParam) return definition.href;
	return `${definition.href}?${definition.projectQueryParam}=${encodeURIComponent(projectId)}`;
}

export function projectDetailHref(projectId: string): string {
	return `/projects/${encodeURIComponent(projectId)}`;
}

export function vaultDetailHref(slug: string, vaultId?: string | null): string {
	const path = `${PROJECT_RESOURCE_LIST_PATHS.vaults}/${encodeURIComponent(slug)}`;
	return vaultId ? `${path}?vault=${encodeURIComponent(vaultId)}` : path;
}

export function decodeResourceRouteParam(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

export function memoryDetailHref(memoryId: string): string {
	return `/memories/${encodeURIComponent(memoryId)}`;
}

export function connectorDetailHref(name: string): string {
	return `/connectors/${encodeURIComponent(name)}`;
}

export function projectResourceScopeLabel(scope: ProjectResourceScope): string {
	switch (scope) {
		case "container":
			return "Project home";
		case "project-managed":
			return "Saved in a project";
		case "activity":
			return "Account activity";
		case "all-agents":
			return "All agents";
	}
}

export function projectResourceCount(
	resource: ProjectResourceDefinition,
	stats: DashboardStats,
	projectCount: number,
): number {
	if (resource.id === "projects") return projectCount;
	return resource.statsKey ? (stats[resource.statsKey] ?? 0) : 0;
}

/** Consistent compact count copy for entity-card metadata. */
export function formatResourceCount(
	value: number | null | undefined,
	singular: string,
	plural = `${singular}s`,
): string | null {
	if (typeof value !== "number") return null;
	return `${value} ${value === 1 ? singular : plural}`;
}
