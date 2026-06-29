import { createFileRoute } from "@tanstack/react-router";
import SkillsPage from "@/app/(dashboard)/skills/page";

export const Route = createFileRoute("/_protected/_dashboard/skills/")({
	component: SkillsPage,
});
