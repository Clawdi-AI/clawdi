import { createFileRoute } from "@tanstack/react-router";
import MemoryDetailPage from "@/app/(dashboard)/memories/[id]/page";

export const Route = createFileRoute("/_protected/_dashboard/memories/$id")({
	component: MemoryDetailPage,
});
