"use client";

import { lazy, Suspense } from "react";
import { HostedProductGate } from "@/components/hosted-product-gate";
import { HostedRouteSkeleton } from "@/components/hosted-route-skeleton";

const IS_HOSTED_BUILD = import.meta.env.VITE_CLAWDI_HOSTED === "true";

// Hosted product surface. The dynamic import is constructed only when hosted
// build is true so OSS builds eliminate the chunk entirely.
const ChannelsPage = IS_HOSTED_BUILD
	? lazy(() =>
			import("@/hosted/v2/channels/channels-page").then((m) => ({ default: m.ChannelsPage })),
		)
	: null;

export default function Page() {
	return (
		<HostedProductGate fallbackHref="/">
			{ChannelsPage ? (
				<Suspense fallback={<HostedRouteSkeleton />}>
					<ChannelsPage />
				</Suspense>
			) : null}
		</HostedProductGate>
	);
}
