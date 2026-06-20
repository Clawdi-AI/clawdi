"use client";

import dynamic from "next/dynamic";
import { HostedRouteSkeleton } from "@/components/hosted-route-skeleton";
import { IS_HOSTED } from "@/lib/hosted";

const RewardsPage = IS_HOSTED
	? dynamic(
			() =>
				import("@/hosted/billing/rewards/rewards-page").then((m) => ({ default: m.RewardsPage })),
			{ loading: HostedRouteSkeleton },
		)
	: null;

export default function Page() {
	return RewardsPage ? <RewardsPage /> : null;
}
