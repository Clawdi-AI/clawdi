import { createFileRoute } from "@tanstack/react-router";
import { routeHeadTitle } from "@/lib/document-title";
import CliAuthorizePage from "@/pages/cli-authorize/page";

export const Route = createFileRoute("/_protected/cli-authorize")({
	head: () => routeHeadTitle("CLI authorization"),
	component: CliAuthorizePage,
});
