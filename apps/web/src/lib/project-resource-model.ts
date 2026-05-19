import type { DashboardStats } from "@/lib/api-schemas";

export type ProjectResourceId =
	| "projects"
	| "skills"
	| "vaults"
	| "sessions"
	| "memories"
	| "connectors";

export type ProjectResourceScope = "container" | "project-managed" | "activity" | "account-wide";
export type ProjectResourceGroup = "project-registry" | "project-resources" | "user-resources";

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

export const PROJECT_RESOURCE_DEFINITIONS = [
	{
		id: "projects",
		label: "Projects",
		singularLabel: "Project",
		navLabel: "Projects",
		description: "Project registry and access boundaries.",
		managementDescription:
			"Create Projects, share access, and open a Project's internal resources.",
		href: "/projects",
		emptyCta: "Create Project",
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
		description: "Reusable instructions installed inside a Project.",
		managementDescription:
			"Manage installed skills from a selected Project or from the Project detail page.",
		href: "/skills",
		emptyCta: "Browse Marketplace",
		routeGroup: "project-resources",
		projectScope: "project-managed",
		pathSegments: ["Projects", "Project", "Skills"],
		projectQueryParam: "project",
		statsKey: "skills_count",
		countLabel: "skills",
	},
	{
		id: "vaults",
		label: "Vaults",
		singularLabel: "Vault",
		navLabel: "Vaults",
		description: "Secret references stored inside a Project.",
		managementDescription:
			"Create vaults and keys in owned Projects; shared Projects stay read-only.",
		href: "/vault",
		emptyCta: "Create Vault",
		routeGroup: "project-resources",
		projectScope: "project-managed",
		pathSegments: ["Projects", "Project", "Vaults"],
		projectQueryParam: "project",
		statsKey: "vault_keys_count",
		countLabel: "keys",
	},
	{
		id: "sessions",
		label: "Sessions",
		singularLabel: "Session",
		navLabel: "Sessions",
		description: "Activity history from connected agents.",
		managementDescription:
			"Browse agent activity; Project context comes from each agent's Home and attached Projects.",
		href: "/sessions",
		emptyCta: "Start Syncing",
		routeGroup: "user-resources",
		projectScope: "activity",
		pathSegments: ["Agents", "Sessions"],
		statsKey: "total_sessions",
		countLabel: "sessions",
	},
	{
		id: "memories",
		label: "Memories",
		singularLabel: "Memory",
		navLabel: "Memories",
		description: "Account-wide context agents can recall.",
		managementDescription: "Manage account memory separately from Project-owned resources.",
		href: "/memories",
		emptyCta: "Add Memory",
		routeGroup: "user-resources",
		projectScope: "account-wide",
		pathSegments: ["Account", "Memory"],
		statsKey: "memories_count",
		countLabel: "memories",
	},
	{
		id: "connectors",
		label: "Connectors",
		singularLabel: "Connector",
		navLabel: "Connectors",
		description: "Account-wide app connections.",
		managementDescription:
			"Connect apps once at the account level; Projects use them through agents and tools.",
		href: "/connectors",
		emptyCta: "Connect App",
		routeGroup: "user-resources",
		projectScope: "account-wide",
		pathSegments: ["Account", "Connectors"],
		statsKey: "connectors_count",
		countLabel: "connectors",
	},
] as const satisfies readonly ProjectResourceDefinition[];

export const PROJECT_RESOURCE_GROUPS = [
	{
		id: "project-registry",
		label: "Project Registry",
		resourceIds: ["projects"],
	},
	{
		id: "project-resources",
		label: "Project Resources",
		resourceIds: ["skills", "vaults"],
	},
	{
		id: "user-resources",
		label: "User Resources",
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

export const PROJECT_MANAGED_RESOURCE_IDS = PROJECT_RESOURCE_DEFINITIONS.filter(
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

export function skillDetailHref(skillKey: string, projectId?: string | null): string {
	const base = `/skills/${encodeURIComponent(skillKey)}`;
	return projectId ? `${base}?project=${encodeURIComponent(projectId)}` : base;
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
			return "Project registry";
		case "project-managed":
			return "Project-managed";
		case "activity":
			return "Activity history";
		case "account-wide":
			return "Account-wide";
	}
}

export function projectResourceScopeDescription(resource: ProjectResourceDefinition): string {
	switch (resource.projectScope) {
		case "container":
			return "Top-level Project and sharing surface.";
		case "project-managed":
			return "Stored in a Project and opened through the selected Project context.";
		case "activity":
			return "User activity, with Project context inherited through agents.";
		case "account-wide":
			return "User-level resource, not Project-owned today.";
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
