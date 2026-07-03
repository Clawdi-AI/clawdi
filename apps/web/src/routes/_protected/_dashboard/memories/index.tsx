import { createFileRoute } from "@tanstack/react-router";
import { routeHeadTitle } from "@/lib/document-title";
import MemoriesPage from "@/pages/dashboard/memories/page";

export const Route = createFileRoute("/_protected/_dashboard/memories/")({
	head: () => routeHeadTitle("Memories"),
	component: MemoriesPage,
});
