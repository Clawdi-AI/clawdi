import { createFileRoute } from "@tanstack/react-router";
import SessionsPage from "@/app/(dashboard)/sessions/page";

export const Route = createFileRoute("/_protected/_dashboard/sessions/")({
	component: SessionsPage,
});
