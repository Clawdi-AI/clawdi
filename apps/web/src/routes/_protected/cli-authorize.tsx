import { createFileRoute } from "@tanstack/react-router";
import CliAuthorizePage from "@/app/cli-authorize/page";

export const Route = createFileRoute("/_protected/cli-authorize")({
	component: CliAuthorizePage,
});
