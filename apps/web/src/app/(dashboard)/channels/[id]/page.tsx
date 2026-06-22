"use client";

import dynamic from "next/dynamic";
import { HostedRouteSkeleton } from "@/components/hosted-route-skeleton";
import { V2Gate } from "@/components/v2-gate";
import { IS_HOSTED } from "@/lib/hosted";

const ChannelDetailPage = IS_HOSTED
	? dynamic(
			() =>
				import("@/hosted/channels/channel-detail-page").then((m) => ({
					default: m.ChannelDetailPage,
				})),
			{ loading: HostedRouteSkeleton },
		)
	: null;

export default function Page() {
	return ChannelDetailPage ? (
		<V2Gate fallbackHref="/">
			<ChannelDetailPage />
		</V2Gate>
	) : null;
}
