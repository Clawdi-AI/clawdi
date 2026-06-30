"use client";

import { useRouter } from "@tanstack/react-router";
import { type ReactNode, useEffect } from "react";
import { HostedRouteSkeleton } from "@/components/hosted-route-skeleton";
import { IS_HOSTED } from "@/lib/hosted";
import { useV2Access } from "@/lib/v2-access";

export function V2Gate({
	children,
	fallbackHref = "/",
}: {
	children: ReactNode;
	fallbackHref?: string;
}) {
	const router = useRouter();
	const access = useV2Access();
	const allowed = IS_HOSTED && access.canUseV2;
	const denied = !access.isLoading && !allowed;

	useEffect(() => {
		if (denied) void router.navigate({ href: fallbackHref, replace: true });
	}, [denied, fallbackHref, router]);

	if (access.isLoading) return <HostedRouteSkeleton />;
	if (!allowed) return null;
	return <>{children}</>;
}
