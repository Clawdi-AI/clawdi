"use client";

import dynamic from "next/dynamic";
import { HostedRouteSkeleton } from "@/components/hosted-route-skeleton";
import { V2Gate } from "@/components/v2-gate";
import { IS_HOSTED } from "@/lib/hosted";

// V2-gated surface. The dynamic import is constructed only when `IS_HOSTED` is
// true so OSS builds eliminate the chunk entirely.
const ChannelsPage = IS_HOSTED
	? dynamic(
			() => import("@/v2/channels/channels-page").then((m) => ({ default: m.ChannelsPage })),
			{ loading: HostedRouteSkeleton },
		)
	: null;

export default function Page() {
	return ChannelsPage ? (
		<V2Gate fallbackHref="/">
			<ChannelsPage />
		</V2Gate>
	) : null;
}
