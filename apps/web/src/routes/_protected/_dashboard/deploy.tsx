import { createFileRoute } from "@tanstack/react-router";
import { routeHeadTitle } from "@/lib/document-title";
import DeployPage from "@/pages/dashboard/deploy/page";

export const Route = createFileRoute("/_protected/_dashboard/deploy")({
	head: () => routeHeadTitle("Deploy an Agent"),
	component: DeployPage,
});
