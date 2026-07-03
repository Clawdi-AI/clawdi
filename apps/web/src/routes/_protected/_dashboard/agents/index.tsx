import { createFileRoute } from "@tanstack/react-router";
import { routeHeadTitle } from "@/lib/document-title";
import AgentsIndexPage from "@/pages/dashboard/agents/page";

export const Route = createFileRoute("/_protected/_dashboard/agents/")({
	head: () => routeHeadTitle("Agents"),
	component: AgentsIndexPage,
});
