import { createFileRoute, lazyRouteComponent, notFound, redirect } from "@tanstack/react-router";
import {
	agentSectionLabel,
	agentSectionLink,
	CONNECTED_AGENT_SECTION_IDS,
	parseAgentSectionSegment,
} from "@/lib/agent-routes";
import { routeHeadTitle } from "@/lib/document-title";
import { AGENT_PROJECT_RESOURCE_SECTION_IDS } from "@/lib/navigation-model";

const IS_HOSTED_BUILD = import.meta.env.VITE_CLAWDI_HOSTED === "true";

function safeDecodeURIComponent(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

export const Route = createFileRoute("/_protected/_dashboard/agents/$id/$section")({
	codeSplitGroupings: [],
	beforeLoad: ({ params }) => {
		const section = parseAgentSectionSegment(safeDecodeURIComponent(params.section));
		if (!section || section === "overview") throw notFound();
		const isCompatibilityProjectResource = AGENT_PROJECT_RESOURCE_SECTION_IDS.some(
			(candidate) => candidate === section,
		);
		if (
			!IS_HOSTED_BUILD &&
			!isCompatibilityProjectResource &&
			!CONNECTED_AGENT_SECTION_IDS.some((candidate) => candidate === section)
		) {
			throw redirect({ ...agentSectionLink(params.id, "overview"), replace: true });
		}
		return { section };
	},
	head: ({ params }) => {
		const section = parseAgentSectionSegment(safeDecodeURIComponent(params.section));
		return routeHeadTitle(section && section !== "overview" ? agentSectionLabel(section) : "Agent");
	},
	component: IS_HOSTED_BUILD
		? lazyRouteComponent(() => import("@/hosted/agents/agent-home"), "HostedAgentSectionPage")
		: lazyRouteComponent(
				() => import("@/pages/dashboard/agents/agent-detail-client"),
				"AgentSectionPage",
			),
});
