import { createFileRoute } from "@tanstack/react-router";
import ProjectsPage from "@/pages/dashboard/projects/page";

export const Route = createFileRoute("/_protected/_dashboard/projects/")({
	component: ProjectsPage,
});
