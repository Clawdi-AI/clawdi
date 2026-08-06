import { linkOptions } from "@tanstack/react-router";
import {
	type AgentRouteQuery,
	agentConnectorDetailHref,
	agentConnectorDetailLink,
	agentDeploymentRouteQuery,
	agentMemoryDetailHref,
	agentMemoryDetailLink,
	agentProjectDetailHref,
	agentProjectDetailLink,
	agentProjectResourceHref,
	agentSectionHref,
	agentVaultDetailHref,
	agentVaultDetailLink,
} from "@/lib/agent-routes";
import {
	connectorDetailHref,
	memoryDetailHref,
	PROJECT_RESOURCE_LIST_PATHS,
	projectDetailHref,
	vaultDetailHref,
} from "@/lib/project-resource-model";

export type ResourceNavigationScope =
	| { kind: "library" }
	| {
			kind: "agent";
			agentId: string;
			agentQuery?: AgentRouteQuery;
			/** Project selected before opening Project-scoped Agent resources. */
			projectId?: string;
	  };

export type ResourceCollection = "projects" | "vaults" | "memories" | "connectors";
type ProjectAssignedResource = Extract<ResourceCollection, "projects" | "vaults">;

export type ResourceNavigationTarget = {
	href: string;
	label: string;
};

export const LIBRARY_RESOURCE_SCOPE = {
	kind: "library",
} as const satisfies ResourceNavigationScope;

export function agentResourceScope(
	agentId: string,
	agentQuery?: AgentRouteQuery,
	projectId?: string,
): ResourceNavigationScope {
	return { kind: "agent", agentId, agentQuery, projectId };
}

export function resourceCollectionTarget(
	scope: ResourceNavigationScope,
	resource: ResourceCollection,
): ResourceNavigationTarget {
	if (scope.kind === "library") {
		return {
			href: PROJECT_RESOURCE_LIST_PATHS[resource],
			label: getResourceCollectionLabel(resource),
		};
	}
	if (resource === "vaults") {
		return scope.projectId
			? {
					href: agentProjectResourceHref(
						scope.agentId,
						scope.projectId,
						"vaults",
						agentDeploymentRouteQuery(scope.agentQuery),
					),
					label: "Vaults",
				}
			: {
					href: agentSectionHref(
						scope.agentId,
						"projects",
						agentDeploymentRouteQuery(scope.agentQuery),
					),
					label: "Projects",
				};
	}
	return {
		href: agentSectionHref(scope.agentId, resource, agentDeploymentRouteQuery(scope.agentQuery)),
		label: resource === "projects" ? "Projects" : getResourceCollectionLabel(resource),
	};
}

function getResourceCollectionLabel(resource: ResourceCollection): string {
	switch (resource) {
		case "projects":
			return "Projects";
		case "vaults":
			return "Vaults";
		case "memories":
			return "Memories";
		case "connectors":
			return "Connectors";
	}
}

export function projectDetailHrefForScope(
	scope: ResourceNavigationScope,
	projectId: string,
): string {
	return scope.kind === "agent"
		? agentProjectDetailHref(scope.agentId, projectId, agentDeploymentRouteQuery(scope.agentQuery))
		: projectDetailHref(projectId);
}

export function projectDetailLink(scope: ResourceNavigationScope, projectId: string) {
	return scope.kind === "agent"
		? agentProjectDetailLink(scope.agentId, projectId, agentDeploymentRouteQuery(scope.agentQuery))
		: linkOptions({ to: "/projects/$id", params: { id: projectId } });
}

export function vaultDetailHrefForScope(
	scope: ResourceNavigationScope,
	vaultSlug: string,
	vaultId?: string | null,
): string {
	return scope.kind === "agent"
		? agentVaultDetailHref(scope.agentId, vaultSlug, vaultId, agentProjectResourceQuery(scope))
		: vaultDetailHref(vaultSlug, vaultId);
}

export function vaultDetailLink(
	scope: ResourceNavigationScope,
	vaultSlug: string,
	vaultId?: string | null,
) {
	return scope.kind === "agent"
		? agentVaultDetailLink(scope.agentId, vaultSlug, vaultId, agentProjectResourceQuery(scope))
		: linkOptions({
				to: "/vaults/$slug",
				params: { slug: vaultSlug },
				search: vaultId ? { vault: vaultId } : undefined,
			});
}

function agentProjectResourceQuery(
	scope: Extract<ResourceNavigationScope, { kind: "agent" }>,
): AgentRouteQuery {
	return {
		...agentDeploymentRouteQuery(scope.agentQuery),
		project: scope.projectId,
	};
}

export function memoryDetailHrefForScope(scope: ResourceNavigationScope, memoryId: string): string {
	return scope.kind === "agent"
		? agentMemoryDetailHref(scope.agentId, memoryId, agentDeploymentRouteQuery(scope.agentQuery))
		: memoryDetailHref(memoryId);
}

export function memoryDetailLink(scope: ResourceNavigationScope, memoryId: string) {
	return scope.kind === "agent"
		? agentMemoryDetailLink(scope.agentId, memoryId, agentDeploymentRouteQuery(scope.agentQuery))
		: linkOptions({ to: "/memories/$id", params: { id: memoryId } });
}

export function connectorDetailHrefForScope(
	scope: ResourceNavigationScope,
	connectorName: string,
): string {
	return scope.kind === "agent"
		? agentConnectorDetailHref(
				scope.agentId,
				connectorName,
				agentDeploymentRouteQuery(scope.agentQuery),
			)
		: connectorDetailHref(connectorName);
}

export function connectorDetailLink(scope: ResourceNavigationScope, connectorName: string) {
	return scope.kind === "agent"
		? agentConnectorDetailLink(
				scope.agentId,
				connectorName,
				agentDeploymentRouteQuery(scope.agentQuery),
			)
		: linkOptions({ to: "/connectors/$name", params: { name: connectorName } });
}

export function libraryManagementTarget(
	resource: ProjectAssignedResource,
	identity: { projectId: string } | { vaultSlug: string; vaultId?: string | null },
): ResourceNavigationTarget {
	return {
		href:
			resource === "projects" && "projectId" in identity
				? projectDetailHref(identity.projectId)
				: "vaultSlug" in identity
					? vaultDetailHref(identity.vaultSlug, identity.vaultId)
					: PROJECT_RESOURCE_LIST_PATHS[resource],
		label: "Manage in resource library",
	};
}

type LegacyResourceNavigationQuery =
	| URLSearchParams
	| Readonly<Record<string, unknown>>
	| null
	| undefined;

function queryValue(query: LegacyResourceNavigationQuery, key: string): string | undefined {
	if (!query) return undefined;
	if (query instanceof URLSearchParams) return query.get(key)?.trim() || undefined;
	const value = query[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Compatibility bridge for links emitted by the first navigation-context PR.
 * New Agent navigation uses nested paths and never writes these query keys.
 */
export function legacyAgentResourceScope(
	query: LegacyResourceNavigationQuery,
	resource: ProjectAssignedResource,
): ResourceNavigationScope | null {
	const expectedOrigin = resource === "projects" ? "agent-projects" : "agent-vaults";
	if (queryValue(query, "from") !== expectedOrigin) return null;
	const agentId = queryValue(query, "agent");
	if (!agentId) return null;
	const source = queryValue(query, "agentSource");
	const deployment = queryValue(query, "agentDeployment");
	return {
		kind: "agent",
		agentId,
		agentQuery: source || deployment ? { source, d: deployment } : undefined,
	};
}

export type ResourceDetailSearch = Record<string, unknown> & {
	vault?: string;
	project?: string;
	tab?: string;
	useWithAgent?: string;
	joined?: string;
	from?: string;
	agent?: string;
	agentSource?: string;
	agentDeployment?: string;
};

export function validateResourceDetailSearch(
	search: Record<string, unknown>,
): ResourceDetailSearch {
	const optionalString = (value: unknown) => (typeof value === "string" ? value : undefined);
	const validated: ResourceDetailSearch = { ...search };
	for (const key of [
		"vault",
		"project",
		"tab",
		"useWithAgent",
		"joined",
		"from",
		"agent",
		"agentSource",
		"agentDeployment",
	] as const) {
		const value = optionalString(search[key]);
		if (value === undefined) delete validated[key];
		else validated[key] = value;
	}
	return validated;
}
