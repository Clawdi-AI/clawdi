import type { DashboardStats } from "@/lib/api-schemas";

export type ProjectResourceId =
	| "projects"
	| "skills"
	| "vaults"
	| "sessions"
	| "memories"
	| "connectors";

export type ProjectResourceScope = "container" | "project-managed" | "activity" | "account-wide";
type DashboardStatCountKey = {
	[K in keyof DashboardStats]: DashboardStats[K] extends number ? K : never;
}[keyof DashboardStats];

export interface ProjectResourceDefinition {
	id: ProjectResourceId;
	label: string;
	singularLabel: string;
	description: string;
	href: string;
	emptyCta: string;
	projectScope: ProjectResourceScope;
	projectQueryParam?: "project";
	statsKey?: DashboardStatCountKey;
	countLabel?: string;
}

export const PROJECT_RESOURCE_DEFINITIONS = [
	{
		id: "projects",
		label: "Projects",
		singularLabel: "Project",
		description: "Resource workspaces and access boundaries.",
		href: "/projects",
		emptyCta: "Create workspace",
		projectScope: "container",
		countLabel: "projects",
	},
	{
		id: "skills",
		label: "Skills",
		singularLabel: "Skill",
		description: "Reusable instructions installed into a Project.",
		href: "/skills",
		emptyCta: "Browse marketplace",
		projectScope: "project-managed",
		projectQueryParam: "project",
		statsKey: "skills_count",
		countLabel: "skills",
	},
	{
		id: "vaults",
		label: "Vault keys",
		singularLabel: "Vault",
		description: "Secret references stored in a Project.",
		href: "/vault",
		emptyCta: "Create your first",
		projectScope: "project-managed",
		projectQueryParam: "project",
		statsKey: "vault_keys_count",
		countLabel: "keys",
	},
	{
		id: "sessions",
		label: "Sessions",
		singularLabel: "Session",
		description: "Activity history from connected agents.",
		href: "/sessions",
		emptyCta: "Start syncing",
		projectScope: "activity",
		statsKey: "total_sessions",
		countLabel: "sessions",
	},
	{
		id: "memories",
		label: "Memories",
		singularLabel: "Memory",
		description: "Account-wide context agents can recall.",
		href: "/memories",
		emptyCta: "Add your first",
		projectScope: "account-wide",
		statsKey: "memories_count",
		countLabel: "memories",
	},
	{
		id: "connectors",
		label: "Connectors",
		singularLabel: "Connector",
		description: "Account-wide app connections.",
		href: "/connectors",
		emptyCta: "Connect an app",
		projectScope: "account-wide",
		statsKey: "connectors_count",
		countLabel: "connectors",
	},
] as const satisfies readonly ProjectResourceDefinition[];

export const PROJECT_MANAGED_RESOURCE_IDS = PROJECT_RESOURCE_DEFINITIONS.filter(
	(resource) => resource.projectScope === "project-managed",
).map((resource) => resource.id);

export function getProjectResourceDefinition(id: ProjectResourceId): ProjectResourceDefinition {
	const definition = PROJECT_RESOURCE_DEFINITIONS.find((resource) => resource.id === id);
	if (!definition) throw new Error(`Unknown project resource: ${id}`);
	return definition;
}

export function projectResourceHref(id: ProjectResourceId, projectId?: string): string {
	const definition = getProjectResourceDefinition(id);
	if (!projectId || !definition.projectQueryParam) return definition.href;
	return `${definition.href}?${definition.projectQueryParam}=${encodeURIComponent(projectId)}`;
}

export function projectResourceScopeLabel(scope: ProjectResourceScope): string {
	switch (scope) {
		case "container":
			return "Resource workspace";
		case "project-managed":
			return "Project-managed";
		case "activity":
			return "Activity history";
		case "account-wide":
			return "Account-wide";
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
