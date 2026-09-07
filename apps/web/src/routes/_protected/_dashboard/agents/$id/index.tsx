import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";
import { routeHeadTitle } from "@/lib/document-title";

export const Route = createFileRoute("/_protected/_dashboard/agents/$id/")({
	// The section route already loads AgentDetailClient; avoid a serial wrapper chunk.
	codeSplitGroupings: [],
	head: () => routeHeadTitle("Agent"),
	component: lazyRouteComponent(
		() => import("@/pages/dashboard/agents/agent-detail-client"),
		"AgentOverviewPage",
	),
});
