import { createFileRoute } from "@tanstack/react-router";
import { routeHeadTitle } from "@/lib/document-title";
import SkillsPage from "@/pages/dashboard/skills/page";

export const Route = createFileRoute("/_protected/_dashboard/skills/")({
	head: () => routeHeadTitle("Skills"),
	component: SkillsPage,
});
