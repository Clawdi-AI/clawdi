import { createFileRoute } from "@tanstack/react-router";
import MemoriesPage from "@/pages/dashboard/memories/page";

export const Route = createFileRoute("/_protected/_dashboard/memories/")({
	component: MemoriesPage,
});
