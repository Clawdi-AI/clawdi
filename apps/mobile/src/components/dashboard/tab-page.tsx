import { dashboardPageClasses as page, siteHeaderClasses as styles } from "@clawdi/shared/ui";
import type { ReactNode } from "react";
import { RefreshControl } from "react-native";
import { AppSafeAreaView, AppScrollView } from "@/components/ui/view";
import { WebText, WebView, webView } from "@/components/ui/web-layout";
/** Native tabs replace the sidebar; retain the slim Web page-name header. */
export function TabPage({
	title,
	children,
	refreshing = false,
	onRefresh,
	actions,
}: {
	title: string;
	children: ReactNode;
	refreshing?: boolean;
	onRefresh?: () => void;
	actions?: ReactNode;
}) {
	return (
		<AppSafeAreaView
			edges={["top", "left", "right"]}
			className={`flex-1 ${webView(styles.pageSurface)}`}
		>
			<WebView recipe={styles.root} style={{ height: 48 }}>
				<WebView recipe={styles.content} className="flex-row">
					<WebText recipe={page.connectCardTitle} className="flex-1">
						{title}
					</WebText>
					{actions}
				</WebView>
			</WebView>
			<AppScrollView
				contentInsetAdjustmentBehavior="never"
				refreshControl={
					onRefresh ? <RefreshControl refreshing={refreshing} onRefresh={onRefresh} /> : undefined
				}
			>
				<WebView recipe={page.root} style={{ paddingTop: 20, paddingBottom: 24 }}>
					{children}
				</WebView>
			</AppScrollView>
		</AppSafeAreaView>
	);
}
