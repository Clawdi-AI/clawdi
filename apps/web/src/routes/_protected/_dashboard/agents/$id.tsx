import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import {
	agentConnectorDetailLink,
	agentMemoryDetailLink,
	agentPluginDetailLink,
	agentProjectDetailLink,
	agentProjectResourceLink,
	agentRouteIdsEqual,
	agentSectionLink,
	agentSessionDetailLink,
	agentSkillDetailLink,
	agentVaultDetailLink,
	legacyAgentRoute,
	parseAgentPathname,
	validateAgentRouteSearch,
} from "@/lib/agent-routes";

export const Route = createFileRoute("/_protected/_dashboard/agents/$id")({
	validateSearch: validateAgentRouteSearch,
	beforeLoad: ({ params, search, location }) => {
		const currentRoute = parseAgentPathname(location.pathname);
		const fallbackSection =
			currentRoute && agentRouteIdsEqual(currentRoute.agentId, params.id)
				? currentRoute.section
				: "overview";
		const legacy = legacyAgentRoute(fallbackSection, search);
		if (legacy) {
			if (currentRoute?.sessionId) {
				throw redirect({
					...agentSessionDetailLink(params.id, currentRoute.sessionId, legacy.search),
					replace: true,
				});
			}
			if (currentRoute?.skillKey) {
				const projectId =
					typeof legacy.search?.project === "string" ? legacy.search.project : undefined;
				throw redirect({
					...agentSkillDetailLink(params.id, currentRoute.skillKey, projectId, legacy.search),
					replace: true,
				});
			}
			if (currentRoute?.projectId && currentRoute.projectResource) {
				throw redirect({
					...agentProjectResourceLink(
						params.id,
						currentRoute.projectId,
						currentRoute.projectResource,
						legacy.search,
					),
					replace: true,
				});
			}
			if (currentRoute?.projectId) {
				throw redirect({
					...agentProjectDetailLink(params.id, currentRoute.projectId, legacy.search),
					replace: true,
				});
			}
			if (currentRoute?.vaultSlug) {
				throw redirect({
					...agentVaultDetailLink(
						params.id,
						currentRoute.vaultSlug,
						typeof legacy.search?.vault === "string" ? legacy.search.vault : undefined,
						legacy.search,
					),
					replace: true,
				});
			}
			if (currentRoute?.memoryId) {
				throw redirect({
					...agentMemoryDetailLink(params.id, currentRoute.memoryId, legacy.search),
					replace: true,
				});
			}
			if (currentRoute?.connectorName) {
				throw redirect({
					...agentConnectorDetailLink(params.id, currentRoute.connectorName, legacy.search),
					replace: true,
				});
			}
			if (currentRoute?.pluginName) {
				throw redirect({
					...agentPluginDetailLink(params.id, currentRoute.pluginName, legacy.search),
					replace: true,
				});
			}
			throw redirect({
				...agentSectionLink(params.id, legacy.section, legacy.search),
				replace: true,
			});
		}
	},
	component: Outlet,
});
