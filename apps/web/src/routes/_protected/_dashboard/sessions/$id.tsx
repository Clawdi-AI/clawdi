import { createFileRoute } from "@tanstack/react-router";
import SessionDetailPage from "@/app/(dashboard)/sessions/[id]/page";

export const Route = createFileRoute("/_protected/_dashboard/sessions/$id")({
	component: SessionDetailPage,
});
