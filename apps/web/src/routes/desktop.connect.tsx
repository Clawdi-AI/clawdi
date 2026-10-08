import { createFileRoute } from "@tanstack/react-router";
import { routeHeadTitle } from "@/lib/document-title";
import { DesktopConnectPage } from "@/pages/desktop-connect";

export const Route = createFileRoute("/desktop/connect")({
	head: () => routeHeadTitle("Open Clawdi Desktop"),
	component: DesktopConnectPage,
});
