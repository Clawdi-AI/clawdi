import { createFileRoute } from "@tanstack/react-router";
import SkillDetailPage from "@/app/(dashboard)/skills/[key]/page";

export const Route = createFileRoute("/_protected/_dashboard/skills/$key")({
	component: SkillDetailPage,
});
