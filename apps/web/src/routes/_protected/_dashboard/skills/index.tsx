import { createFileRoute } from "@tanstack/react-router";
import SkillsPage from "@/pages/dashboard/skills/page";

export const Route = createFileRoute("/_protected/_dashboard/skills/")({
	component: SkillsPage,
});
