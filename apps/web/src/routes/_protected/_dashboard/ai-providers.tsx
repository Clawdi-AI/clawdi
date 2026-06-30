import { createFileRoute } from "@tanstack/react-router";
import AiProvidersRoutePage from "@/pages/dashboard/ai-providers/page";

export const Route = createFileRoute("/_protected/_dashboard/ai-providers")({
	component: AiProvidersRoutePage,
});
