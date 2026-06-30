"use client";

import { lazy, Suspense } from "react";
import { HostedRouteSkeleton } from "@/components/hosted-route-skeleton";
import { V2Gate } from "@/components/v2-gate";

const IS_HOSTED_BUILD = import.meta.env.VITE_CLAWDI_HOSTED === "true";

// V2-gated surface. The dynamic import is constructed only when hosted build is
// true so OSS builds eliminate the chunk entirely.
const ChannelsPage = IS_HOSTED_BUILD
	? lazy(() => import("@/v2/channels/channels-page").then((m) => ({ default: m.ChannelsPage })))
	: null;

export default function Page() {
	return (
		<V2Gate fallbackHref="/">
			{ChannelsPage ? (
				<Suspense fallback={<HostedRouteSkeleton />}>
					<ChannelsPage />
				</Suspense>
			) : null}
		</V2Gate>
	);
}
