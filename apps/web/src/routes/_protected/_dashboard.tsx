import { createFileRoute, Outlet } from "@tanstack/react-router";
import DashboardLayout from "@/app/(dashboard)/layout";

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
