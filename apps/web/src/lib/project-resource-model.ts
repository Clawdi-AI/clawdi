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
		description: "Create Custom Projects and review managed Projects.",
		managementDescription:
			"Use Custom Projects for shareable work. Global and Agent Projects are managed for you.",
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
		managementDescription: "Pick a Project, then install or remove the skills saved there.",
		href: "/skills",
		emptyCta: "Browse Marketplace",
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
		description: "Vaults and keys stored inside a Project.",
		managementDescription:
			"Create vaults and keys in Projects you own. Shared Custom Projects stay read-only.",
		href: "/vault",
		emptyCta: "Create Vault",
		routeGroup: "project-resources",
		projectScope: "project-managed",
		pathSegments: ["Projects", "Selected Project", "Vaults"],
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
			"Browse conversations synced from agents. Each session shows which agent produced it.",
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
		description: "Account-level notes agents can recall.",
		managementDescription: "Manage memories separately from resources saved in Projects.",
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
			"Connect apps once at the account level. Agents can use them through tools.",
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
		label: "Projects",
		resourceIds: ["projects"],
	},
	{
		id: "project-resources",
		label: "In Projects",
		resourceIds: ["skills", "vaults"],
	},
	{
		id: "user-resources",
		label: "Account",
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
			return "Agent activity";
		case "account-wide":
			return "Account level";
	}
}

export function projectResourceScopeDescription(resource: ProjectResourceDefinition): string {
	switch (resource.projectScope) {
		case "container":
			return "Start here to create Projects, share Custom Projects, or open Project resources.";
		case "project-managed":
			return "Saved in one Project. Pick the Project before you add, edit, or remove it.";
		case "activity":
			return "Activity from agents, shown with the agent that produced it.";
		case "account-wide":
			return "Managed for your account, not inside a specific Project.";
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
