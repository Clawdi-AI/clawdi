import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";
import { routeHeadTitle } from "@/lib/document-title";

const IS_HOSTED_BUILD = import.meta.env.VITE_CLAWDI_HOSTED === "true";

export const Route = createFileRoute("/_protected/_dashboard/agents/$id/")({
	// Let Router preload the actual page, without a wrapper or nested React.lazy waterfall.
	codeSplitGroupings: [],
	head: () => routeHeadTitle("Agent"),
	component: IS_HOSTED_BUILD
		? lazyRouteComponent(() => import("@/hosted/agents/agent-home"), "HostedAgentOverviewPage")
		: lazyRouteComponent(
				() => import("@/pages/dashboard/agents/agent-detail-client"),
				"AgentOverviewPage",
			),
});
