"use client";

import { useLocation } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { HostedProductGate } from "@/components/hosted-product-gate";
import { HostedRouteSkeleton } from "@/components/hosted-route-skeleton";

const IS_HOSTED_BUILD = import.meta.env.VITE_CLAWDI_HOSTED === "true";
const RuntimeWindowSurface = IS_HOSTED_BUILD
	? lazy(() =>
			import("@/hosted/agents/runtime-window-status").then((module) => ({
				default: module.RuntimeWindowSurface,
			})),
		)
	: null;

export default function Page() {
	const searchStr = useLocation({ select: (location) => location.searchStr });
	const reason = new URLSearchParams(searchStr).get("reason");
	return (
		<HostedProductGate fallbackHref="/">
			{RuntimeWindowSurface ? (
				<Suspense fallback={<HostedRouteSkeleton />}>
					<RuntimeWindowSurface reason={reason} />
				</Suspense>
			) : null}
		</HostedProductGate>
	);
}
