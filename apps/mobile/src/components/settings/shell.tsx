import { settingsDialogClasses as styles } from "@clawdi/shared/ui";
import type { ReactNode } from "react";
import { AppScrollView } from "@/components/ui/view";
import { webView } from "@/components/ui/web-layout";
import { SafeAreaScreen } from "@/platform/safe-area-screen";

/** One settings panel screen; the Account tab's settings menu owns panel navigation. */
export function SettingsShell({
	children,
	scroll = true,
}: {
	children: ReactNode;
	scroll?: boolean;
}) {
	return (
		<SafeAreaScreen>
			{scroll ? (
				<AppScrollView
					keyboardShouldPersistTaps="handled"
					contentInsetAdjustmentBehavior="automatic"
					contentContainerClassName={webView(styles.panel)}
				>
					{children}
				</AppScrollView>
			) : (
				children
			)}
		</SafeAreaScreen>
	);
}
