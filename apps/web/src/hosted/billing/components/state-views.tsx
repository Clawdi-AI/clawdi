"use client";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/** A single card skeleton (header + body lines) matching the Card primitive. */
function CardSkeleton({ lines = 3, className }: { lines?: number; className?: string }) {
	return (
		<Card data-hosted="true" className={className}>
			<CardHeader>
				<Skeleton className="h-5 w-32" />
				<Skeleton className="h-4 w-48" />
			</CardHeader>
			<CardContent className="space-y-3">
				{Array.from({ length: lines }, (_, i) => `l-${i}`).map((key) => (
					<Skeleton key={key} className="h-4 w-full" />
				))}
			</CardContent>
		</Card>
	);
}

/** Subscription: dunning slot + the current-plan card. */
export function SubscriptionSkeleton() {
	return (
		<div data-hosted="true" className="space-y-6">
			<CardSkeleton lines={4} />
		</div>
	);
}

/** Wallet: balance hero + the auto-reload / x402 row + the activity table. */
export function WalletSkeleton() {
	return (
		<div data-hosted="true" className="space-y-6">
			<Skeleton className="h-28 w-full rounded-lg" />
			<div className="grid gap-4 lg:grid-cols-2">
				<CardSkeleton lines={3} />
				<CardSkeleton lines={2} />
			</div>
			<Skeleton className="h-64 w-full rounded-lg" />
		</div>
	);
}

/** Usage: total cards + daily chart + by-model rows. */
export function UsageSkeleton() {
	return (
		<div data-hosted="true" className="space-y-6">
			<div className="grid gap-3 sm:grid-cols-2">
				<CardSkeleton lines={1} />
				<CardSkeleton lines={1} />
			</div>
			<Card data-hosted="true">
				<CardHeader>
					<Skeleton className="h-5 w-36" />
				</CardHeader>
				<CardContent>
					<div className="flex h-28 items-end gap-1">
						{Array.from({ length: 14 }, (_, i) => `day-${i}`).map((key, index) => (
							<Skeleton
								key={key}
								className="flex-1 rounded-t"
								style={{ height: `${Math.max(16, ((index % 7) + 2) * 10)}%` }}
							/>
						))}
					</div>
					<div className="mt-2 flex justify-between">
						<Skeleton className="h-3 w-10" />
						<Skeleton className="h-3 w-10" />
					</div>
				</CardContent>
			</Card>
			<CardSkeleton lines={5} />
		</div>
	);
}
