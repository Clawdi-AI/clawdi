import { routeLoadingSkeletonClasses } from "@clawdi/shared/ui";
import { PageHeaderSkeleton } from "@/components/page-header";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** Stable loading fallback for lazy dashboard routes and settings surfaces. */
export function RouteLoadingSkeleton() {
	return (
		<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, routeLoadingSkeletonClasses.root)}>
			<PageHeaderSkeleton actions />
			<div className={routeLoadingSkeletonClasses.body}>
				<Skeleton className={routeLoadingSkeletonClasses.heading} />
				<Skeleton className={routeLoadingSkeletonClasses.description} />
				<Skeleton className={routeLoadingSkeletonClasses.content} />
			</div>
		</div>
	);
}
