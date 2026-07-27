import { createFileRoute } from "@tanstack/react-router";
import { routeHeadTitle } from "@/lib/document-title";
import RuntimeWindowPage from "@/pages/dashboard/runtime-window/page";

export const Route = createFileRoute("/_protected/runtime-window")({
	head: () => routeHeadTitle("Runtime window changed"),
	component: RuntimeWindowPage,
});
