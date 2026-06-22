"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useEffect } from "react";
import { HostedRouteSkeleton } from "@/components/hosted-route-skeleton";
import { IS_HOSTED } from "@/lib/hosted";
import { useHostedV2Access } from "@/lib/hosted-v2-access";

export function HostedV2Gate({
	children,
	fallbackHref,
}: {
	children: ReactNode;
	fallbackHref?: string;
}) {
	const router = useRouter();
	const access = useHostedV2Access();
	const allowed = IS_HOSTED && access.canUseV2;
	const denied = !access.isLoading && !allowed;

	useEffect(() => {
		if (denied && fallbackHref) router.replace(fallbackHref);
	}, [denied, fallbackHref, router]);

	if (access.isLoading) return <HostedRouteSkeleton />;
	if (!allowed) return null;
	return <>{children}</>;
}
