"use client";

import { Skeleton } from "@/components/ui/skeleton";

function SectionSkeleton({ children }: { children: React.ReactNode }) {
	return (
		<div className="space-y-4 border-t pt-4">
			<div className="space-y-2">
				<Skeleton className="h-4 w-28" />
				<Skeleton className="h-4 w-52 max-w-full" />
			</div>
			{children}
		</div>
	);
}

/** Compute: actions, billing history, and the two comparable plan cards. */
export function SubscriptionSkeleton() {
	return (
		<div data-hosted="true" className="space-y-8">
			<SectionSkeleton>
				<div className="flex flex-wrap gap-2">
					<Skeleton className="h-9 w-36" />
					<Skeleton className="h-9 w-36" />
				</div>
			</SectionSkeleton>
			<SectionSkeleton>
				<Skeleton className="h-28 w-full rounded-lg" />
			</SectionSkeleton>
			<div className="grid gap-3 lg:grid-cols-2">
				<Skeleton className="h-72 w-full rounded-xl" />
				<Skeleton className="h-72 w-full rounded-xl" />
			</div>
		</div>
	);
}

/** Wallet: balance hero followed by the same flat sections as loaded content. */
export function WalletSkeleton() {
	return (
		<div data-hosted="true" className="space-y-8">
			<Skeleton className="h-36 w-full rounded-xl" />
			<SectionSkeleton>
				<div className="grid max-w-3xl gap-4 sm:grid-cols-2">
					<Skeleton className="h-16 w-full rounded-md" />
					<Skeleton className="h-16 w-full rounded-md" />
				</div>
			</SectionSkeleton>
			<SectionSkeleton>
				<Skeleton className="h-9 w-40" />
			</SectionSkeleton>
			<SectionSkeleton>
				<Skeleton className="h-40 w-full rounded-lg" />
			</SectionSkeleton>
		</div>
	);
}

/** Usage: metric strip, daily trend, then peer agent and model breakdowns. */
export function UsageSkeleton() {
	return (
		<div data-hosted="true" className="space-y-8">
			<div className="grid overflow-hidden rounded-lg border sm:grid-cols-2 sm:divide-x">
				<div className="space-y-2 p-4">
					<Skeleton className="h-8 w-28" />
					<Skeleton className="h-4 w-36" />
				</div>
				<div className="space-y-2 border-t p-4 sm:border-t-0">
					<Skeleton className="h-8 w-20" />
					<Skeleton className="h-4 w-32" />
				</div>
			</div>
			<SectionSkeleton>
				<Skeleton className="h-44 w-full rounded-lg" />
			</SectionSkeleton>
			<SectionSkeleton>
				<div className="space-y-3">
					<Skeleton className="h-10 w-full" />
					<Skeleton className="h-10 w-full" />
					<Skeleton className="h-10 w-full" />
				</div>
			</SectionSkeleton>
			<SectionSkeleton>
				<div className="space-y-3">
					<Skeleton className="h-10 w-full" />
					<Skeleton className="h-10 w-full" />
					<Skeleton className="h-10 w-full" />
				</div>
			</SectionSkeleton>
		</div>
	);
}
