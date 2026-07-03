import { createFileRoute } from "@tanstack/react-router";
import { routeHeadTitle } from "@/lib/document-title";
import SessionsPage from "@/pages/dashboard/sessions/page";

export const Route = createFileRoute("/_protected/_dashboard/sessions/")({
	head: () => routeHeadTitle("Sessions"),
	component: SessionsPage,
});
