import { Skeleton } from "@/components/ui/skeleton";

/**
 * Loading fallback for hosted-build-gated lazy route imports (billing,
 * channels, ai-providers, deploy). Without it the chunk load shows a blank frame before
 * the page's own skeleton mounts. Its header and flat sections mirror Settings
 * page chrome so lazy loading does not shift the content hierarchy.
 */
export function HostedRouteSkeleton() {
	return (
		<div className="flex flex-col gap-8 px-5 sm:px-6 lg:px-8">
			<div className="space-y-2">
				<Skeleton className="h-6 w-36" />
				<Skeleton className="h-4 w-64 max-w-full" />
			</div>
			<div className="space-y-4 border-t pt-4">
				<Skeleton className="h-4 w-28" />
				<Skeleton className="h-4 w-56 max-w-full" />
				<Skeleton className="h-24 w-full rounded-lg" />
			</div>
		</div>
	);
}
