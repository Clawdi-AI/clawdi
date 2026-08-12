"use client";

import { Skeleton } from "@/components/ui/skeleton";

function SectionSkeleton({
	children,
	description = true,
	actions,
}: {
	children?: React.ReactNode;
	description?: boolean;
	actions?: React.ReactNode;
}) {
	return (
		<div className="space-y-4 border-t pt-4">
			<div className="flex items-start justify-between gap-3">
				<div className="space-y-2">
					<Skeleton className="h-4 w-28" />
					{description ? <Skeleton className="h-4 w-52 max-w-full" /> : null}
				</div>
				{actions}
			</div>
			{children}
		</div>
	);
}

/** Compute: subscription controls and the two comparable plan cards. */
export function SubscriptionSkeleton() {
	return (
		<div data-hosted="true" className="space-y-8">
			<SectionSkeleton>
				<div className="flex flex-wrap gap-2">
					<Skeleton className="h-9 w-36" />
					<Skeleton className="h-9 w-36" />
				</div>
			</SectionSkeleton>
			<SectionSkeleton
				description={false}
				actions={<Skeleton className="h-9 w-56 shrink-0 rounded-md" />}
			>
				<div className="grid gap-3 lg:grid-cols-2">
					<Skeleton className="h-72 w-full rounded-xl" />
					<Skeleton className="h-72 w-full rounded-xl" />
				</div>
			</SectionSkeleton>
		</div>
	);
}

/** Wallet: balance hero followed by the same flat sections as loaded content. */
export function WalletSkeleton() {
	return (
		<div data-hosted="true" className="space-y-8">
			<Skeleton className="h-36 w-full rounded-xl" />
			<SectionSkeleton
				description={false}
				actions={<Skeleton className="h-5 w-9 shrink-0 rounded-full" />}
			/>
			<SectionSkeleton />
			<SectionSkeleton
				description={false}
				actions={<Skeleton className="h-8 w-40 shrink-0 rounded-md" />}
			>
				<Skeleton className="h-40 w-full rounded-lg" />
			</SectionSkeleton>
		</div>
	);
}

/** Usage: scoped totals, spend trend, and model table. */
export function UsageSkeleton() {
	return (
		<div data-hosted="true" className="space-y-8">
			<div className="grid overflow-hidden rounded-lg border sm:grid-cols-2 sm:divide-x">
				<div className="space-y-2 p-4">
					<Skeleton className="h-4 w-36" />
					<Skeleton className="h-8 w-28" />
				</div>
				<div className="space-y-2 border-t p-4 sm:border-t-0">
					<Skeleton className="h-4 w-32" />
					<Skeleton className="h-8 w-20" />
				</div>
			</div>
			<SectionSkeleton description={false}>
				<Skeleton className="h-44 w-full" />
			</SectionSkeleton>
			<SectionSkeleton description={false}>
				<div className="space-y-3">
					<Skeleton className="h-10 w-full" />
					<Skeleton className="h-10 w-full" />
					<Skeleton className="h-10 w-full" />
				</div>
			</SectionSkeleton>
		</div>
	);
}
