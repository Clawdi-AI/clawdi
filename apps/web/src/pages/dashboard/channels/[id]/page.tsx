"use client";

import { lazy, Suspense } from "react";
import { HostedRouteSkeleton } from "@/components/hosted-route-skeleton";
import { V2Gate } from "@/components/v2-gate";

const IS_HOSTED_BUILD = import.meta.env.VITE_CLAWDI_HOSTED === "true";

const ChannelDetailPage = IS_HOSTED_BUILD
	? lazy(() =>
			import("@/v2/channels/channel-detail-page").then((m) => ({
				default: m.ChannelDetailPage,
			})),
		)
	: null;

export default function ChannelDetailRoutePage({ channelId }: { channelId: string }) {
	return (
		<V2Gate fallbackHref="/">
			{ChannelDetailPage ? (
				<Suspense fallback={<HostedRouteSkeleton />}>
					<ChannelDetailPage channelId={channelId} />
				</Suspense>
			) : null}
		</V2Gate>
	);
}
