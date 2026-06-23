"use client";

import dynamic from "next/dynamic";
import { HostedRouteSkeleton } from "@/components/hosted-route-skeleton";
import { V2Gate } from "@/components/v2-gate";
import { IS_HOSTED } from "@/lib/hosted";

// Codex "Sign in with ChatGPT" OAuth callback for the v2 AI Providers surface.
// OSS builds tree-shake it via the IS_HOSTED-gated dynamic import.
const CodexOAuthCallback = IS_HOSTED
	? dynamic(
			() => import("@/v2/ai-providers/codex-oauth-callback").then((m) => m.CodexOAuthCallback),
			{ loading: HostedRouteSkeleton },
		)
	: null;

export default function CodexOAuthCallbackPage() {
	return <V2Gate fallbackHref="/">{CodexOAuthCallback ? <CodexOAuthCallback /> : null}</V2Gate>;
}
