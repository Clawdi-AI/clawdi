import { dashboardPageClasses as page, siteHeaderClasses as styles } from "@clawdi/shared/ui";
import type { ReactNode } from "react";
import { RefreshControl } from "react-native";
import { AppSafeAreaView, AppScrollView } from "../view";
import { WebText, WebView, webView } from "../web-layout";
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
			<WebView recipe={styles.stickyTop0Z20} style={{ height: 48 }}>
				<WebView recipe={styles.flexWFullMinW} className="flex-row">
					<WebText recipe={page.minW0TextSm} className="flex-1">
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
				<WebView recipe={page.spaceY5Px4} style={{ paddingTop: 20, paddingBottom: 24 }}>
					{children}
				</WebView>
			</AppScrollView>
		</AppSafeAreaView>
	);
}
