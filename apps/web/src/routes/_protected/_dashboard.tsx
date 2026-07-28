import { createFileRoute, Outlet } from "@tanstack/react-router";
import { validateDashboardSettingsSearch } from "@/lib/settings-routes";
import DashboardLayout from "@/pages/dashboard/layout";

export const Route = createFileRoute("/_protected/_dashboard")({
	validateSearch: validateDashboardSettingsSearch,
	component: DashboardRouteLayout,
});

function DashboardRouteLayout() {
	return (
		<DashboardLayout>
			<Outlet />
		</DashboardLayout>
	);
}
