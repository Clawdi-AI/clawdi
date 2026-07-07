"use client";

import { useRouter } from "@tanstack/react-router";
import { type ReactNode, useEffect } from "react";
import { HostedRouteSkeleton } from "@/components/hosted-route-skeleton";
import { IS_HOSTED } from "@/lib/hosted";
import { useHostedProductAccess } from "@/lib/hosted-product-access";

export function HostedProductGate({
	children,
	fallbackHref = "/",
}: {
	children: ReactNode;
	fallbackHref?: string;
}) {
	const router = useRouter();
	const access = useHostedProductAccess();
	const allowed = IS_HOSTED && access.canCreateCloudAgents;
	const denied = !access.isLoading && !allowed;

	useEffect(() => {
		if (denied) void router.navigate({ href: fallbackHref, replace: true });
	}, [denied, fallbackHref, router]);

	if (access.isLoading) return <HostedRouteSkeleton />;
	if (!allowed) return null;
	return <>{children}</>;
}
