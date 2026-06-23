"use client";

import dynamic from "next/dynamic";
import { HostedRouteSkeleton } from "@/components/hosted-route-skeleton";
import { IS_HOSTED } from "@/lib/hosted";

const UsagePage = IS_HOSTED
	? dynamic(
			() => import("@/hosted/billing/usage/usage-page").then((m) => ({ default: m.UsagePage })),
			{ loading: HostedRouteSkeleton },
		)
	: null;

export default function Page() {
	return UsagePage ? <UsagePage /> : null;
}
