import type { DashboardStats } from "@/lib/api-schemas";

export type ProjectResourceId =
	| "projects"
	| "skills"
	| "vaults"
	| "sessions"
	| "memories"
	| "connectors";

export type ProjectResourceScope = "container" | "project-managed" | "activity" | "all-agents";
export type ProjectResourceGroup = "project-registry" | "project-resources" | "user-resources";

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

export const PROJECT_CANONICAL_DEFINITION =
	"A Project stores Skills and attaches Vault access for a workflow or team.";

const PROJECT_RESOURCE_DEFINITIONS = [
	{
		id: "projects",
		label: "Projects",
		singularLabel: "Project",
		navLabel: "Projects",
		description: PROJECT_CANONICAL_DEFINITION,
		managementDescription:
			"Create Projects to share resources with teammates. Use the Global Project for account defaults. Workspaces belong to one connected Agent and cannot be shared.",
		href: PROJECT_RESOURCE_LIST_PATHS.projects,
		emptyCta: "Create project",
		routeGroup: "project-registry",
		projectScope: "container",
		pathSegments: ["Projects"],
		countLabel: "projects",
	},
	{
		id: "skills",
		label: "Skills",
		singularLabel: "Skill",
		navLabel: "Skills",
		description: "Reusable instructions stored and managed in a Project.",
		managementDescription:
			"Skills are stored in Projects. Choose a Project, then install or uninstall its Skills. Install each Skill on an Agent separately to run it.",
		href: PROJECT_RESOURCE_LIST_PATHS.skills,
		emptyCta: "Browse marketplace",
		routeGroup: "project-resources",
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
		description: "Encrypted key collections attached to one or more Projects.",
		managementDescription:
			"Store API keys once, then attach Vaults to the Projects where Agents should use those keys.",
		href: PROJECT_RESOURCE_LIST_PATHS.vaults,
		emptyCta: "Create vault",
		routeGroup: "project-resources",
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
		description: "Conversation history synced from connected agents.",
		managementDescription:
			"Sessions are agent activity. Browse conversations and filter by the agent that produced them.",
		href: PROJECT_RESOURCE_LIST_PATHS.sessions,
		emptyCta: "Start syncing",
		routeGroup: "user-resources",
		projectScope: "activity",
		pathSegments: ["Account resources", "Sessions"],
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
		routeGroup: "user-resources",
		projectScope: "all-agents",
		pathSegments: ["Account resources", "Memory"],
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
		routeGroup: "user-resources",
		projectScope: "all-agents",
		pathSegments: ["Account resources", "Connectors"],
		statsKey: "connectors_count",
		countLabel: "connectors",
	},
] as const satisfies readonly ProjectResourceDefinition[];

export const PROJECT_RESOURCE_GROUPS = [
	{
		id: "project-registry",
		label: "Projects",
		resourceIds: ["projects"],
	},
	{
		id: "project-resources",
		label: "Project resources",
		resourceIds: ["skills", "vaults"],
	},
	{
		id: "user-resources",
		label: "Account resources",
		resourceIds: ["sessions", "memories", "connectors"],
	},
] as const satisfies readonly {
	id: ProjectResourceGroup;
	label: string;
	resourceIds: readonly ProjectResourceId[];
}[];

export const PROJECT_RESOURCE_NAV_IDS = PROJECT_RESOURCE_GROUPS.flatMap((group) =>
	group.resourceIds.map((id) => id),
);

const PROJECT_MANAGED_RESOURCE_IDS = PROJECT_RESOURCE_DEFINITIONS.filter(
	(resource) => resource.projectScope === "project-managed",
).map((resource) => resource.id);

export function getProjectResourceDefinition(id: ProjectResourceId): ProjectResourceDefinition {
	const definition = PROJECT_RESOURCE_DEFINITIONS.find((resource) => resource.id === id);
	if (!definition) throw new Error(`Unknown project resource: ${id}`);
	return definition;
}

export function projectResourceDefinitionsForGroup(
	group: ProjectResourceGroup,
): ProjectResourceDefinition[] {
	const ids = PROJECT_RESOURCE_GROUPS.find((item) => item.id === group)?.resourceIds ?? [];
	return ids.map((id) => getProjectResourceDefinition(id));
}

export function projectManagedResourceDefinitions(): ProjectResourceDefinition[] {
	return PROJECT_MANAGED_RESOURCE_IDS.map((id) => getProjectResourceDefinition(id));
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

export function skillDetailHref(skillKey: string, projectId?: string | null): string {
	const base = `/skills/${encodeURIComponent(skillKey)}`;
	return projectId ? `${base}?project=${encodeURIComponent(projectId)}` : base;
}

export function decodeResourceRouteParam(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

export function sessionDetailHref(sessionId: string): string {
	return `/sessions/${encodeURIComponent(sessionId)}`;
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
			return "Saved in a Project";
		case "activity":
			return "Account resources";
		case "all-agents":
			return "All agents";
	}
}

export function projectResourceScopeDescription(resource: ProjectResourceDefinition): string {
	switch (resource.projectScope) {
		case "container":
			return "Start here to create shareable Projects or open Project resources.";
		case "project-managed":
			return "Saved in a Project. Pick the Project before you add, edit, or remove it.";
		case "activity":
			return "Activity from agents, shown with the agent that produced it.";
		case "all-agents":
			return "Shared across all agents in this account. Changes here affect all agents.";
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
