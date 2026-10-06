import { routeLoadingSkeletonClasses } from "@clawdi/shared/ui";
import { PageHeaderSkeleton } from "@/components/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { AppView } from "@/components/ui/view";
import { webView } from "@/components/ui/web-layout";
export function RouteLoadingSkeleton() {
	return (
		<AppView className={webView(routeLoadingSkeletonClasses.root)}>
			<PageHeaderSkeleton />
			<AppView className={webView(routeLoadingSkeletonClasses.body)}>
				<Skeleton className={webView(routeLoadingSkeletonClasses.heading)} />
				<Skeleton className={webView(routeLoadingSkeletonClasses.description)} />
				<Skeleton className={webView(routeLoadingSkeletonClasses.content)} />
			</AppView>
		</AppView>
	);
}
