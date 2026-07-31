import { createFileRoute } from "@tanstack/react-router";
import { routeHeadTitle } from "@/lib/document-title";
import CodexOAuthCallbackPage from "@/pages/oauth/codex/callback/page";

export const Route = createFileRoute("/_protected/oauth/codex/callback")({
	head: () => routeHeadTitle("Codex sign-in"),
	component: CodexOAuthCallbackPage,
});
