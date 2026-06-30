import { createFileRoute } from "@tanstack/react-router";
import CliAuthorizePage from "@/pages/cli-authorize/page";

export const Route = createFileRoute("/_protected/cli-authorize")({
	component: CliAuthorizePage,
});
