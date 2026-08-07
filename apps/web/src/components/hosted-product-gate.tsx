"use client";

import { useRouter } from "@tanstack/react-router";
import { type ReactNode, useEffect } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { HostedRouteSkeleton } from "@/components/hosted-route-skeleton";
import { useHostedProductAccess } from "@/lib/hosted-product-access";
import { useCommittedRouteIsLatestTarget } from "@/lib/use-committed-location";

export function HostedProductGate({
	children,
	fallbackHref = "/",
}: {
	children: ReactNode;
	fallbackHref?: string;
}) {
	const router = useRouter();
	const access = useHostedProductAccess();
	const isLatestTarget = useCommittedRouteIsLatestTarget();

	useEffect(() => {
		if (access.isDenied && isLatestTarget)
			void router.navigate({ href: fallbackHref, replace: true });
	}, [access.isDenied, fallbackHref, isLatestTarget, router]);

	if (access.isLoading) return <HostedRouteSkeleton />;
	if (access.isError) {
		return (
			<div className="mx-auto flex min-h-[50vh] w-full max-w-2xl items-center p-6">
				<ApiErrorPanel
					error={access.error}
					onRetry={() => {
						void access.refetch();
					}}
					title="Couldn't verify access"
				/>
			</div>
		);
	}
	if (!access.isAllowed) return null;
	return <>{children}</>;
}
