"use client";

import dynamic from "next/dynamic";
import { HostedRouteSkeleton } from "@/components/hosted-route-skeleton";
import { IS_HOSTED } from "@/lib/hosted";

// Hosted-only surface. The dynamic import is constructed only when
// `IS_HOSTED` is true so OSS builds eliminate the chunk entirely.
const ChannelsPage = IS_HOSTED
	? dynamic(
			() => import("@/hosted/channels/channels-page").then((m) => ({ default: m.ChannelsPage })),
			{ loading: HostedRouteSkeleton },
		)
	: null;

export default function Page() {
	return ChannelsPage ? <ChannelsPage /> : null;
}
