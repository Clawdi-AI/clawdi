"use client";

import { lazy, Suspense } from "react";
import { HostedRouteSkeleton } from "@/components/hosted-route-skeleton";
import { V2Gate } from "@/components/v2-gate";

// Codex "Sign in with ChatGPT" OAuth callback for the v2 AI Providers surface.
const IS_HOSTED_BUILD = import.meta.env.VITE_CLAWDI_HOSTED === "true";

const CodexOAuthCallback = IS_HOSTED_BUILD
	? lazy(() =>
			import("@/v2/ai-providers/codex-oauth-callback").then((m) => ({
				default: m.CodexOAuthCallback,
			})),
		)
	: null;

export default function CodexOAuthCallbackPage() {
	return (
		<V2Gate fallbackHref="/">
			{CodexOAuthCallback ? (
				<Suspense fallback={<HostedRouteSkeleton />}>
					<CodexOAuthCallback />
				</Suspense>
			) : null}
		</V2Gate>
	);
}
