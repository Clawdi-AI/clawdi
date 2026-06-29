import { createFileRoute } from "@tanstack/react-router";
import CodexOAuthCallbackPage from "@/pages/oauth/codex/callback/page";

export const Route = createFileRoute("/_protected/oauth/codex/callback")({
	component: CodexOAuthCallbackPage,
});
