"use client";

import { lazy, Suspense } from "react";
import { HostedProductGate } from "@/components/hosted-product-gate";
import { HostedRouteSkeleton } from "@/components/hosted-route-skeleton";

// Codex "Sign in with ChatGPT" OAuth callback for the hosted AI Providers surface.
const IS_HOSTED_BUILD = import.meta.env.VITE_CLAWDI_HOSTED === "true";

const CodexOAuthCallback = IS_HOSTED_BUILD
	? lazy(() =>
			import("@/hosted/v2/ai-providers/codex-oauth-callback").then((m) => ({
				default: m.CodexOAuthCallback,
			})),
		)
	: null;

export default function CodexOAuthCallbackPage() {
	return (
		<HostedProductGate fallbackHref="/">
			{CodexOAuthCallback ? (
				<Suspense fallback={<HostedRouteSkeleton />}>
					<CodexOAuthCallback />
				</Suspense>
			) : null}
		</HostedProductGate>
	);
}
