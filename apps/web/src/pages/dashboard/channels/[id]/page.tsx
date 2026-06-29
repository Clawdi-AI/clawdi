"use client";

import { HostedRouteSkeleton } from "@/components/hosted-route-skeleton";
import { V2Gate } from "@/components/v2-gate";
import dynamic from "@/lib/dynamic";

const IS_HOSTED_BUILD = import.meta.env.VITE_CLAWDI_HOSTED === "true";

const ChannelDetailPage = IS_HOSTED_BUILD
	? dynamic(
			() =>
				import("@/v2/channels/channel-detail-page").then((m) => ({
					default: m.ChannelDetailPage,
				})),
			{ loading: HostedRouteSkeleton },
		)
	: null;

export default function ChannelDetailRoutePage({ channelId }: { channelId: string }) {
	return (
		<V2Gate fallbackHref="/">
			{ChannelDetailPage ? <ChannelDetailPage channelId={channelId} /> : null}
		</V2Gate>
	);
}
