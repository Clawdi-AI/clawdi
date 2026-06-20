"use client";

import dynamic from "next/dynamic";
import { HostedRouteSkeleton } from "@/components/hosted-route-skeleton";
import { IS_HOSTED } from "@/lib/hosted";

const SubscriptionPage = IS_HOSTED
	? dynamic(
			() =>
				import("@/hosted/billing/subscription/subscription-page").then((m) => ({
					default: m.SubscriptionPage,
				})),
			{ loading: HostedRouteSkeleton },
		)
	: null;

export default function Page() {
	return SubscriptionPage ? <SubscriptionPage /> : null;
}
