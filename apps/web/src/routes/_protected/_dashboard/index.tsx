import { createFileRoute } from "@tanstack/react-router";
import DashboardPage from "@/app/(dashboard)/page";

export const Route = createFileRoute("/_protected/_dashboard/")({
	component: DashboardPage,
});
