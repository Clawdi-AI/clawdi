"use client";

import { lazy, Suspense } from "react";
import { HostedRouteSkeleton } from "@/components/hosted-route-skeleton";

const IS_HOSTED_BUILD = import.meta.env.VITE_CLAWDI_HOSTED === "true";
const CodexOAuthCallback = IS_HOSTED_BUILD
	? lazy(() =>
			import("@/hosted/v2/ai-providers/codex-oauth-callback").then((module) => ({
				default: module.CodexOAuthCallback,
			})),
		)
	: null;

export default function CodexOAuthCallbackPage() {
	return CodexOAuthCallback ? (
		<Suspense fallback={<HostedRouteSkeleton />}>
			<CodexOAuthCallback />
		</Suspense>
	) : null;
}
