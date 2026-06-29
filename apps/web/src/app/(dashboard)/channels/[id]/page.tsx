"use client";

import { HostedRouteSkeleton } from "@/components/hosted-route-skeleton";
import { V2Gate } from "@/components/v2-gate";
import dynamic from "@/lib/dynamic";
import { IS_HOSTED } from "@/lib/hosted";

const ChannelDetailPage = IS_HOSTED
	? dynamic(
			() =>
				import("@/v2/channels/channel-detail-page").then((m) => ({
					default: m.ChannelDetailPage,
				})),
			{ loading: HostedRouteSkeleton },
		)
	: null;

export default function Page() {
	return <V2Gate fallbackHref="/">{ChannelDetailPage ? <ChannelDetailPage /> : null}</V2Gate>;
}
