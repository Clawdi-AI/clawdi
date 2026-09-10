import { createFileRoute, Outlet, retainSearchParams } from "@tanstack/react-router";
import { validateDashboardSettingsSearch } from "@/lib/settings-routes";
import DashboardLayout from "@/pages/dashboard/layout";

export const Route = createFileRoute("/_protected/_dashboard")({
	validateSearch: validateDashboardSettingsSearch,
	search: { middlewares: [retainSearchParams(["deploy_profile", "utm_source"])] },
	component: DashboardRouteLayout,
});

function DashboardRouteLayout() {
	return (
		<DashboardLayout>
			<Outlet />
		</DashboardLayout>
	);
}
