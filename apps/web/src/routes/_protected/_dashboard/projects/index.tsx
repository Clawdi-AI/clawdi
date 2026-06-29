import { createFileRoute } from "@tanstack/react-router";
import ProjectsPage from "@/app/(dashboard)/projects/page";

export const Route = createFileRoute("/_protected/_dashboard/projects/")({
	component: ProjectsPage,
});
