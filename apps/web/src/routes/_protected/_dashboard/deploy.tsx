import { createFileRoute } from "@tanstack/react-router";
import DeployPage from "@/app/(dashboard)/deploy/page";

export const Route = createFileRoute("/_protected/_dashboard/deploy")({
	component: DeployPage,
});
