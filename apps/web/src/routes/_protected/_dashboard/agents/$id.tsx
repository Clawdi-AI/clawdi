import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import {
	agentRouteIdsEqual,
	agentSectionLink,
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
			throw redirect({
				...agentSectionLink(params.id, legacy.section, legacy.search),
				replace: true,
			});
		}
	},
	component: Outlet,
});
