import { createFileRoute } from "@tanstack/react-router";
import DeployPage from "@/pages/dashboard/deploy/page";

export const Route = createFileRoute("/_protected/_dashboard/deploy")({
	component: DeployPage,
});
