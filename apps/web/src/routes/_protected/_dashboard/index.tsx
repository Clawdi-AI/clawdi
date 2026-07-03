import { createFileRoute } from "@tanstack/react-router";
import { routeHeadTitle } from "@/lib/document-title";
import DashboardPage from "@/pages/dashboard/page";

export const Route = createFileRoute("/_protected/_dashboard/")({
	head: () => routeHeadTitle("Overview"),
	component: DashboardPage,
});
