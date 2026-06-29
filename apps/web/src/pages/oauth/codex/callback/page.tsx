"use client";

import { HostedRouteSkeleton } from "@/components/hosted-route-skeleton";
import { V2Gate } from "@/components/v2-gate";
import dynamic from "@/lib/dynamic";

// Codex "Sign in with ChatGPT" OAuth callback for the v2 AI Providers surface.
const IS_HOSTED_BUILD = import.meta.env.VITE_CLAWDI_HOSTED === "true";

const CodexOAuthCallback = IS_HOSTED_BUILD
	? dynamic(
			() => import("@/v2/ai-providers/codex-oauth-callback").then((m) => m.CodexOAuthCallback),
			{ loading: HostedRouteSkeleton },
		)
	: null;

export default function CodexOAuthCallbackPage() {
	return <V2Gate fallbackHref="/">{CodexOAuthCallback ? <CodexOAuthCallback /> : null}</V2Gate>;
}
