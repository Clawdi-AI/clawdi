import { createFileRoute } from "@tanstack/react-router";
import { routeHeadTitle } from "@/lib/document-title";
import AiProvidersRoutePage from "@/pages/dashboard/ai-providers/page";

export const Route = createFileRoute("/_protected/_dashboard/ai-providers")({
	head: () => routeHeadTitle("Model Providers"),
	component: AiProvidersRoutePage,
});
