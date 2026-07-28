import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import {
	agentRouteIdsEqual,
	agentSectionLink,
	agentSessionDetailLink,
	agentSkillDetailLink,
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
			throw redirect({
				...agentSectionLink(params.id, legacy.section, legacy.search),
				replace: true,
			});
		}
	},
	component: Outlet,
});
