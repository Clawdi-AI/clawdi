import { routeLoadingSkeletonClasses } from "@clawdi/shared/ui";
import { PageHeaderSkeleton } from "./page-header";
import { Skeleton } from "./skeleton";
import { AppView } from "./view";
import { webView } from "./web-layout";
export function RouteLoadingSkeleton() {
	return (
		<AppView className={webView(routeLoadingSkeletonClasses.root)}>
			<PageHeaderSkeleton actions />
			<AppView className={webView(routeLoadingSkeletonClasses.body)}>
				<Skeleton className={webView(routeLoadingSkeletonClasses.heading)} />
				<Skeleton className={webView(routeLoadingSkeletonClasses.description)} />
				<Skeleton className={webView(routeLoadingSkeletonClasses.content)} />
			</AppView>
		</AppView>
	);
}
