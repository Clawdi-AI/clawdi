"use client";

import { lazy, type ReactNode, Suspense } from "react";
import { RouteLoadingSkeleton } from "@/components/route-loading-skeleton";

const IS_HOSTED_BUILD = import.meta.env.VITE_CLAWDI_HOSTED === "true";

const HostedProductGate = IS_HOSTED_BUILD
	? lazy(() =>
			import("@/hosted/access/hosted-product-gate").then((m) => ({
				default: m.HostedProductGate,
			})),
		)
	: null;

export function HostedProductRoute({
	children,
	fallback = <RouteLoadingSkeleton />,
	fallbackHref = "/",
}: {
	children: ReactNode;
	fallback?: ReactNode;
	fallbackHref?: string;
}) {
	if (!HostedProductGate) return null;

	return (
		<Suspense fallback={fallback}>
			<HostedProductGate fallbackHref={fallbackHref}>{children}</HostedProductGate>
		</Suspense>
	);
}
