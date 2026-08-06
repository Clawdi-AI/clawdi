import { PageHeaderSkeleton } from "@/components/page-header";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * Loading fallback for hosted-build-gated lazy route imports (billing,
 * channels, ai-providers, deploy). Without it the chunk load shows a blank frame before
 * the page's own skeleton mounts. Its header and flat sections mirror Settings
 * page chrome so lazy loading does not shift the content hierarchy.
 */
export function HostedRouteSkeleton() {
	return (
		<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, "flex flex-col gap-6 px-4 lg:px-6")}>
			<PageHeaderSkeleton actions />
			<div className="space-y-4">
				<Skeleton className="h-4 w-28" />
				<Skeleton className="h-4 w-56 max-w-full" />
				<Skeleton className="h-24 w-full rounded-lg" />
			</div>
		</div>
	);
}
