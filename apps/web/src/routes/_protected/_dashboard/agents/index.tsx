import { createFileRoute } from "@tanstack/react-router";
import AgentsIndexPage from "@/app/(dashboard)/agents/page";

export const Route = createFileRoute("/_protected/_dashboard/agents/")({
	component: AgentsIndexPage,
});
