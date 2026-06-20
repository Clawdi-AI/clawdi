import { Skeleton } from "@/components/ui/skeleton";

/**
 * Loading fallback for the IS_HOSTED-gated `dynamic()` route imports (billing,
 * ai-providers, deploy). Without it the chunk load shows a blank frame before
 * the page's own skeleton mounts. Header + body skeleton matching the canonical
 * `px-4 lg:px-6` page chrome.
 */
export function HostedRouteSkeleton() {
	return (
		<div className="space-y-6 px-4 lg:px-6">
			<div className="space-y-2">
				<Skeleton className="h-8 w-48" />
				<Skeleton className="h-4 w-72" />
			</div>
			<Skeleton className="h-48 w-full rounded-lg" />
		</div>
	);
}
