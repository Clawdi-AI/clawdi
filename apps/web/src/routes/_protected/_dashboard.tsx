import { createFileRoute, Outlet } from "@tanstack/react-router";
import DashboardLayout from "@/pages/dashboard/layout";

export const Route = createFileRoute("/_protected/_dashboard")({
	component: DashboardRouteLayout,
});

function DashboardRouteLayout() {
	return (
		<DashboardLayout>
			<Outlet />
		</DashboardLayout>
	);
}
