import { dashboardPageClasses as page, siteHeaderClasses as styles } from "@clawdi/shared/ui";
import type { ReactNode } from "react";
import { RefreshControl } from "react-native";
import { AppSafeAreaView, AppScrollView } from "@/components/ui/view";
import { WebView, webView } from "@/components/ui/web-layout";
import { NativeHeader } from "@/platform/navigation/native-header";
import type { HeaderAction, HeaderMenu } from "@/platform/navigation/native-header-types";
/** The stack owns chrome; this scroll view owns Web sections and refresh. */
export function TabPage({
	title,
	children,
	refreshing = false,
	onRefresh,
	headerActions,
	headerMenu,
}: {
	title: string;
	children: ReactNode;
	refreshing?: boolean;
	onRefresh?: () => void;
	headerActions?: HeaderAction[];
	headerMenu?: HeaderMenu;
}) {
	return (
		<AppSafeAreaView edges={["left", "right"]} className={`flex-1 ${webView(styles.pageSurface)}`}>
			<NativeHeader title={title} actions={headerActions} menu={headerMenu} />
			<AppScrollView
				contentInsetAdjustmentBehavior="automatic"
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
