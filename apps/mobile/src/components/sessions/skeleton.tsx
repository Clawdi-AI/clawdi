import { sessionDetailClasses as styles } from "@clawdi/shared/ui";
import { Skeleton } from "@/components/ui/skeleton";
import { WebView, webView } from "@/components/ui/web-layout";
export function MessagesSkeleton() {
	return (
		<WebView recipe={styles.skeleton}>
			{Array.from({ length: 4 }, (_, index) => (
				<WebView key={index} recipe={styles.skeletonRow}>
					<Skeleton className={webView(styles.skeletonAvatar)} />
					<WebView recipe={styles.skeletonBody}>
						<Skeleton className={webView(styles.skeletonAuthor)} />
						<Skeleton className={webView(styles.skeletonLine)} />
						{index % 2 ? <Skeleton className={webView(styles.skeletonCode)} /> : null}
					</WebView>
				</WebView>
			))}
		</WebView>
	);
}
