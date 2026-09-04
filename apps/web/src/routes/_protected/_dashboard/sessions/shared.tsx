import { createFileRoute } from "@tanstack/react-router";
import { routeHeadTitle } from "@/lib/document-title";
import SharedSessionLinksPage from "@/pages/dashboard/sessions/shared-page";

export const Route = createFileRoute("/_protected/_dashboard/sessions/shared")({
	head: () => routeHeadTitle("Shared Session links"),
	component: SharedSessionLinksPage,
});
