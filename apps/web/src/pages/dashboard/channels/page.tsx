"use client";

import { HostedRouteSkeleton } from "@/components/hosted-route-skeleton";
import { V2Gate } from "@/components/v2-gate";
import dynamic from "@/lib/dynamic";

const IS_HOSTED_BUILD = import.meta.env.VITE_CLAWDI_HOSTED === "true";

// V2-gated surface. The dynamic import is constructed only when hosted build is
// true so OSS builds eliminate the chunk entirely.
const ChannelsPage = IS_HOSTED_BUILD
	? dynamic(
			() => import("@/v2/channels/channels-page").then((m) => ({ default: m.ChannelsPage })),
			{ loading: HostedRouteSkeleton },
		)
	: null;

export default function Page() {
	return <V2Gate fallbackHref="/">{ChannelsPage ? <ChannelsPage /> : null}</V2Gate>;
}
