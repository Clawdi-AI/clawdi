"use client";

import { useRouter } from "@tanstack/react-router";
import { type ReactNode, useEffect } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { RouteLoadingSkeleton } from "@/components/route-loading-skeleton";
import { useProductAccess } from "@/lib/product-access";
import { useCommittedRouteIsLatestTarget } from "@/lib/use-committed-location";

export function HostedProductGate({
	children,
	fallbackHref = "/",
}: {
	children: ReactNode;
	fallbackHref?: string;
}) {
	const router = useRouter();
	const access = useProductAccess();
	const isLatestTarget = useCommittedRouteIsLatestTarget();

	useEffect(() => {
		if (access.isDenied && isLatestTarget)
			void router.navigate({ href: fallbackHref, replace: true });
	}, [access.isDenied, fallbackHref, isLatestTarget, router]);

	let content: ReactNode = null;
	if (access.isLoading || access.isDenied) content = <RouteLoadingSkeleton />;
	if (access.isError) {
		content = (
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
	if (access.isAllowed) content = children;
	return (
		<div data-hosted="true" className="contents">
			{content}
		</div>
	);
}
