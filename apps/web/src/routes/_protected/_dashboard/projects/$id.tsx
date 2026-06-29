import { createFileRoute } from "@tanstack/react-router";
import ProjectDetailPage from "@/app/(dashboard)/projects/[id]/page";

export const Route = createFileRoute("/_protected/_dashboard/projects/$id")({
	component: ProjectDetailPage,
});
