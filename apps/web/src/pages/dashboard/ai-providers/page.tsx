"use client";

import { lazy, Suspense } from "react";
import { HostedRouteSkeleton } from "@/components/hosted-route-skeleton";
import { V2Gate } from "@/components/v2-gate";

const IS_HOSTED_BUILD = import.meta.env.VITE_CLAWDI_HOSTED === "true";

// V2-gated surface. The dynamic import is constructed only when hosted build is
// true so OSS builds eliminate the chunk entirely.
const AiProvidersPage = IS_HOSTED_BUILD
	? lazy(() =>
			import("@/v2/ai-providers/ai-providers-page").then((m) => ({
				default: m.AiProvidersPage,
			})),
		)
	: null;

export default function Page() {
	return (
		<V2Gate fallbackHref="/">
			{AiProvidersPage ? (
				<Suspense fallback={<HostedRouteSkeleton />}>
					<AiProvidersPage />
				</Suspense>
			) : null}
		</V2Gate>
	);
}
