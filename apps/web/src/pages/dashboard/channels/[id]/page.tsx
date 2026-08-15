"use client";

import { lazy } from "react";
import { HostedProductRoute } from "@/components/hosted-product-route";

const IS_HOSTED_BUILD = import.meta.env.VITE_CLAWDI_HOSTED === "true";

const ChannelDetailPage = IS_HOSTED_BUILD
	? lazy(() =>
			import("@/hosted/v2/channels/channel-detail-page").then((m) => ({
				default: m.ChannelDetailPage,
			})),
		)
	: null;

export default function ChannelDetailRoutePage({ channelId }: { channelId: string }) {
	return ChannelDetailPage ? (
		<HostedProductRoute>
			<ChannelDetailPage channelId={channelId} />
		</HostedProductRoute>
	) : null;
}
