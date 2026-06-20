"use client";

import dynamic from "next/dynamic";
import { HostedRouteSkeleton } from "@/components/hosted-route-skeleton";
import { IS_HOSTED } from "@/lib/hosted";

const WalletPage = IS_HOSTED
	? dynamic(
			() => import("@/hosted/billing/wallet/wallet-page").then((m) => ({ default: m.WalletPage })),
			{ loading: HostedRouteSkeleton },
		)
	: null;

export default function Page() {
	return WalletPage ? <WalletPage /> : null;
}
