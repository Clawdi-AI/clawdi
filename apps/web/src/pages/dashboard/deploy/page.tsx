"use client";

import { lazy } from "react";
import { HostedProductRoute } from "@/components/hosted-product-route";
import { PageHeader } from "@/components/page-header";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

const IS_HOSTED_BUILD = import.meta.env.VITE_CLAWDI_HOSTED === "true";

const DeployWizard = IS_HOSTED_BUILD
	? lazy(() =>
			import("@/hosted/billing/deploy/deploy-wizard").then((m) => ({
				default: m.DeployWizard,
			})),
		)
	: null;

export default function Page() {
	return DeployWizard ? (
		<HostedProductRoute fallback={<DeployRouteSkeleton />}>
			<DeployWizard />
		</HostedProductRoute>
	) : null;
}

function DeployRouteSkeleton() {
	return (
		<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, "flex flex-col gap-6 px-4 lg:px-6")}>
			<PageHeader title="Deploy an Agent" description="Preparing compute options…" />
			{Array.from({ length: 4 }).map((_, sectionIndex) => (
				<section key={sectionIndex} className="flex flex-col gap-4">
					<div className="flex max-w-2xl flex-col gap-2">
						<Skeleton className="h-4 w-24" />
						<Skeleton className="h-3.5 w-80 max-w-full" />
						<Skeleton className="h-3.5 w-56 max-w-full" />
					</div>
					<div className="grid gap-2 @2xl/main:grid-cols-2">
						{Array.from({ length: 2 }).map((_, tileIndex) => (
							<Skeleton key={tileIndex} className="h-[86px] w-full rounded-lg" />
						))}
					</div>
				</section>
			))}
		</div>
	);
}
