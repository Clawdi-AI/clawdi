"use client";

import { lazy } from "react";
import { HostedProductRoute } from "@/components/hosted-product-route";

const IS_HOSTED_BUILD = import.meta.env.VITE_CLAWDI_HOSTED === "true";

// Hosted product surface. The dynamic import is constructed only when hosted
// build is true so OSS builds eliminate the chunk entirely.
const ChannelsPage = IS_HOSTED_BUILD
	? lazy(() =>
			import("@/hosted/v2/channels/channels-page").then((m) => ({
				default: m.ChannelsPage,
			})),
		)
	: null;

export default function Page() {
	return ChannelsPage ? (
		<HostedProductRoute>
			<ChannelsPage />
		</HostedProductRoute>
	) : null;
}
