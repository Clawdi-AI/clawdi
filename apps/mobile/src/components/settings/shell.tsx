import { settingsDialogClasses as styles } from "@clawdi/shared/ui";
import type { ReactElement, ReactNode } from "react";
import type { RefreshControlProps } from "react-native";
import { AppScrollView } from "@/components/ui/view";
import { webView } from "@/components/ui/web-layout";
import { SafeAreaScreen } from "@/platform/safe-area-screen";

/** One settings panel screen; the Account tab's settings menu owns panel navigation. */
export function SettingsShell({
	children,
	scroll = true,
	refreshControl,
}: {
	children: ReactNode;
	scroll?: boolean;
	refreshControl?: ReactElement<RefreshControlProps>;
}) {
	return (
		<SafeAreaScreen>
			{scroll ? (
				<AppScrollView
					keyboardShouldPersistTaps="handled"
					contentInsetAdjustmentBehavior="automatic"
					contentContainerClassName={webView(styles.panel)}
					refreshControl={refreshControl}
				>
					{children}
				</AppScrollView>
			) : (
				children
			)}
		</SafeAreaScreen>
	);
}
