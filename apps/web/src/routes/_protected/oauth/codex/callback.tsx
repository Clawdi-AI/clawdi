import { createFileRoute } from "@tanstack/react-router";
import CodexOAuthCallbackPage from "@/app/oauth/codex/callback/page";

export const Route = createFileRoute("/_protected/oauth/codex/callback")({
	component: CodexOAuthCallbackPage,
});
