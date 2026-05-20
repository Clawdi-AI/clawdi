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

export const PROJECT_CANONICAL_DEFINITION =
	"A Project groups the skills and Vault access an agent or teammate can use.";

export const PROJECT_FIRST_PATH =
	"Create a Custom Project, add Skills or Vaults, then add it to an Agent when it should use them.";

export const PROJECT_RESOURCE_DEFINITIONS = [
	{
		id: "projects",
		label: "Projects",
		singularLabel: "Project",
		navLabel: "Projects",
		description: PROJECT_CANONICAL_DEFINITION,
		managementDescription:
			"Projects you create can be shared. Global Projects and Agent Projects are created automatically and cannot be shared.",
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
		description: "Reusable instructions agents can read from a Project.",
		managementDescription:
			"Skills are Project resources. Choose a Project, then install or remove its skills.",
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
		description: "Encrypted key collections that can be added to one or more Projects.",
		managementDescription:
			"Store API keys once, then add Vaults to the Projects where agents should use those keys.",
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
		description: "Conversation history synced from connected agents.",
		managementDescription:
			"Sessions are agent activity. Browse conversations and filter by the agent that produced them.",
		href: "/sessions",
		emptyCta: "Start Syncing",
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
		description: "Account-level notes agents can recall when they run.",
		managementDescription:
			"Memories are account-level context agents can recall. Project resources stay in Projects.",
		href: "/memories",
		emptyCta: "Add Memory",
		routeGroup: "user-resources",
		projectScope: "account-wide",
		pathSegments: ["Account resources", "Memory"],
		statsKey: "memories_count",
		countLabel: "memories",
	},
	{
		id: "connectors",
		label: "Connectors",
		singularLabel: "Connector",
		navLabel: "Connectors",
		description: "Account-wide app connections that agents can use after approval.",
		managementDescription:
			"Connect apps once at the account level. Agents can use approved connectors through tools.",
		href: "/connectors",
		emptyCta: "Connect App",
		routeGroup: "user-resources",
		projectScope: "account-wide",
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
		label: "In Projects",
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
			return "Account resources";
		case "account-wide":
			return "Account resources";
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
