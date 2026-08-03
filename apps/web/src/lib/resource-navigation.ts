import type { AgentRouteQuery } from "@/lib/agent-routes";
import { agentDeploymentRouteQuery, agentSectionHref } from "@/lib/agent-routes";
import {
	PROJECT_RESOURCE_LIST_PATHS,
	projectDetailHref,
	vaultDetailHref,
} from "@/lib/project-resource-model";

const RESOURCE_ORIGIN_QUERY_KEY = "from";
const RESOURCE_ORIGIN_AGENT_QUERY_KEY = "agent";
const RESOURCE_ORIGIN_AGENT_SOURCE_QUERY_KEY = "agentSource";
const RESOURCE_ORIGIN_AGENT_DEPLOYMENT_QUERY_KEY = "agentDeployment";
const RESOURCE_ORIGIN_PROJECT_QUERY_KEY = "originProject";
const RESOURCE_ORIGIN_VAULT_SLUG_QUERY_KEY = "vaultSlug";
const RESOURCE_ORIGIN_VAULT_ID_QUERY_KEY = "originVault";

export type ResourceNavigationOrigin =
	| {
			type: "agent-projects" | "agent-vaults";
			agentId: string;
			agentQuery?: AgentRouteQuery;
	  }
	| { type: "project"; projectId: string }
	| { type: "vault"; vaultSlug: string; vaultId?: string | null };

export type ResourceReturnTarget = {
	href: string;
	label: string;
};

type ResourceNavigationQuery =
	| URLSearchParams
	| Readonly<Record<string, unknown>>
	| null
	| undefined;

function queryValue(query: ResourceNavigationQuery, key: string): string | undefined {
	if (!query) return undefined;
	if (query instanceof URLSearchParams) return query.get(key)?.trim() || undefined;
	const value = query[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function resourceOriginSearch(
	origin?: ResourceNavigationOrigin | null,
): Record<string, string> {
	if (!origin) return {};
	if (origin.type === "project") {
		return {
			[RESOURCE_ORIGIN_QUERY_KEY]: origin.type,
			[RESOURCE_ORIGIN_PROJECT_QUERY_KEY]: origin.projectId,
		};
	}
	if (origin.type === "vault") {
		return {
			[RESOURCE_ORIGIN_QUERY_KEY]: origin.type,
			[RESOURCE_ORIGIN_VAULT_SLUG_QUERY_KEY]: origin.vaultSlug,
			...(origin.vaultId ? { [RESOURCE_ORIGIN_VAULT_ID_QUERY_KEY]: origin.vaultId } : {}),
		};
	}

	const agentQuery = agentDeploymentRouteQuery(origin.agentQuery);
	const source = typeof agentQuery?.source === "string" ? agentQuery.source : undefined;
	const deployment = typeof agentQuery?.d === "string" ? agentQuery.d : undefined;
	return {
		[RESOURCE_ORIGIN_QUERY_KEY]: origin.type,
		[RESOURCE_ORIGIN_AGENT_QUERY_KEY]: origin.agentId,
		...(source ? { [RESOURCE_ORIGIN_AGENT_SOURCE_QUERY_KEY]: source } : {}),
		...(deployment ? { [RESOURCE_ORIGIN_AGENT_DEPLOYMENT_QUERY_KEY]: deployment } : {}),
	};
}

export function parseResourceNavigationOrigin(
	query: ResourceNavigationQuery,
): ResourceNavigationOrigin | null {
	const type = queryValue(query, RESOURCE_ORIGIN_QUERY_KEY);
	if (type === "project") {
		const projectId = queryValue(query, RESOURCE_ORIGIN_PROJECT_QUERY_KEY);
		return projectId ? { type, projectId } : null;
	}
	if (type === "vault") {
		const vaultSlug = queryValue(query, RESOURCE_ORIGIN_VAULT_SLUG_QUERY_KEY);
		if (!vaultSlug) return null;
		return {
			type,
			vaultSlug,
			vaultId: queryValue(query, RESOURCE_ORIGIN_VAULT_ID_QUERY_KEY),
		};
	}
	if (type === "agent-projects" || type === "agent-vaults") {
		const agentId = queryValue(query, RESOURCE_ORIGIN_AGENT_QUERY_KEY);
		if (!agentId) return null;
		const source = queryValue(query, RESOURCE_ORIGIN_AGENT_SOURCE_QUERY_KEY);
		const deployment = queryValue(query, RESOURCE_ORIGIN_AGENT_DEPLOYMENT_QUERY_KEY);
		return {
			type,
			agentId,
			agentQuery: source || deployment ? { source, d: deployment } : undefined,
		};
	}
	return null;
}

function withSearch(path: string, search: Record<string, string>): string {
	const params = new URLSearchParams(search);
	const query = params.toString().replace(/\+/g, "%20");
	return query ? `${path}${path.includes("?") ? "&" : "?"}${query}` : path;
}

export function projectDetailHrefFrom(
	projectId: string,
	origin?: ResourceNavigationOrigin | null,
): string {
	return withSearch(projectDetailHref(projectId), resourceOriginSearch(origin));
}

export function vaultDetailHrefFrom(
	slug: string,
	vaultId?: string | null,
	origin?: ResourceNavigationOrigin | null,
): string {
	return withSearch(vaultDetailHref(slug, vaultId), resourceOriginSearch(origin));
}

function agentOriginQuery(origin: Extract<ResourceNavigationOrigin, { agentId: string }>) {
	return agentDeploymentRouteQuery(origin.agentQuery);
}

export function projectReturnTarget(query: ResourceNavigationQuery): ResourceReturnTarget {
	const origin = parseResourceNavigationOrigin(query);
	if (origin?.type === "agent-projects") {
		return {
			href: agentSectionHref(origin.agentId, "projects", agentOriginQuery(origin)),
			label: "Agent Projects",
		};
	}
	if (origin?.type === "vault") {
		return {
			href: `${vaultDetailHref(origin.vaultSlug, origin.vaultId)}#projects`,
			label: "Vault",
		};
	}
	return { href: PROJECT_RESOURCE_LIST_PATHS.projects, label: "Projects" };
}

export function vaultReturnTarget(query: ResourceNavigationQuery): ResourceReturnTarget {
	const origin = parseResourceNavigationOrigin(query);
	if (origin?.type === "agent-vaults") {
		return {
			href: agentSectionHref(origin.agentId, "vaults", agentOriginQuery(origin)),
			label: "Agent Vaults",
		};
	}
	if (origin?.type === "project") {
		return { href: `${projectDetailHref(origin.projectId)}#vaults`, label: "Project" };
	}
	return { href: PROJECT_RESOURCE_LIST_PATHS.vaults, label: "Vaults" };
}

export function agentResourceReturnTarget(
	query: ResourceNavigationQuery,
): ResourceReturnTarget | null {
	const origin = parseResourceNavigationOrigin(query);
	if (origin?.type === "project") {
		return { href: `${projectDetailHref(origin.projectId)}#agents`, label: "Project" };
	}
	if (origin?.type === "vault") {
		return {
			href: vaultDetailHref(origin.vaultSlug, origin.vaultId),
			label: "Vault",
		};
	}
	return null;
}
