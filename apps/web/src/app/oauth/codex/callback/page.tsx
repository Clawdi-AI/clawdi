"use client";

import dynamic from "next/dynamic";
import { HostedRouteSkeleton } from "@/components/hosted-route-skeleton";
import { IS_HOSTED } from "@/lib/hosted";

// Codex "Sign in with ChatGPT" OAuth callback. Hosted-only; the OSS bundle
// tree-shakes it via the IS_HOSTED-gated dynamic import.
const CodexOAuthCallback = IS_HOSTED
	? dynamic(
			() => import("@/hosted/ai-providers/codex-oauth-callback").then((m) => m.CodexOAuthCallback),
			{ loading: HostedRouteSkeleton },
		)
	: null;

export default function CodexOAuthCallbackPage() {
	if (!CodexOAuthCallback) return null;
	return <CodexOAuthCallback />;
}
