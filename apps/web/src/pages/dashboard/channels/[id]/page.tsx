"use client";

import { lazy, Suspense } from "react";
import { HostedProductGate } from "@/components/hosted-product-gate";
import { HostedRouteSkeleton } from "@/components/hosted-route-skeleton";

const IS_HOSTED_BUILD = import.meta.env.VITE_CLAWDI_HOSTED === "true";

const ChannelDetailPage = IS_HOSTED_BUILD
	? lazy(() =>
			import("@/hosted/v2/channels/channel-detail-page").then((m) => ({
				default: m.ChannelDetailPage,
			})),
		)
	: null;

export default function ChannelDetailRoutePage({ channelId }: { channelId: string }) {
	return (
		<HostedProductGate fallbackHref="/">
			{ChannelDetailPage ? (
				<Suspense fallback={<HostedRouteSkeleton />}>
					<ChannelDetailPage channelId={channelId} />
				</Suspense>
			) : null}
		</HostedProductGate>
	);
}
