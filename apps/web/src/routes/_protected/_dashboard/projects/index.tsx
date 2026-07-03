import { createFileRoute } from "@tanstack/react-router";
import { routeHeadTitle } from "@/lib/document-title";
import ProjectsPage from "@/pages/dashboard/projects/page";

export const Route = createFileRoute("/_protected/_dashboard/projects/")({
	head: () => routeHeadTitle("Projects"),
	component: ProjectsPage,
});
