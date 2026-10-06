import { detailLayoutClasses } from "@clawdi/shared/ui";
import type { Href } from "expo-router";
import { type ReactNode, useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { AppScrollView } from "@/components/ui/view";
import { WebText, webView } from "@/components/ui/web-layout";
import { useI18n } from "@/lib/i18n";
import { NativeHeader } from "@/platform/navigation/native-header";
import { useSheet } from "@/platform/navigation/use-sheet";
import { SafeAreaScreen } from "@/platform/safe-area-screen";

/** A route sheet has ordinary page content. The parent Stack owns its presentation. */
export function SheetPage({
	title,
	description,
	children,
	fallback,
	busy = false,
 scroll = true,
	sheet: suppliedSheet,
}: {
	title: string;
	description?: ReactNode;
	children: ReactNode;
	fallback: Href;
	busy?: boolean;
 /** Data sheets delegate scrolling to NativeList. */
 scroll?: boolean;
	/** Pass the form's useSheet instance when it also closes with a mutation result. */
	sheet?: { close: () => Promise<void> };
}) {
	const t = useI18n();
	const defaultSheet = useSheet({ fallback, busy: suppliedSheet ? false : busy });
	const sheet = suppliedSheet ?? defaultSheet;
	const [error, setError] = useState<unknown>();
	return (
		<SafeAreaScreen>
			<NativeHeader
				title={title}
				actions={[
					{
						id: "close",
						label: t("composite.cancel"),
						disabled: busy,
						onPress: () => {
							void sheet.close().catch(setError);
						},
					},
				]}
			/>
			{scroll ? <AppScrollView
				contentInsetAdjustmentBehavior="automatic"
				keyboardShouldPersistTaps="handled"
				contentContainerClassName={webView(detailLayoutClasses.detailPage)}
			>
				{description ? (
					<WebText recipe="text-sm text-muted-foreground">{description}</WebText>
				) : null}
				{error ? <ApiErrorPanel error={error} /> : null}
				{children}
			</AppScrollView> : <>{error ? <ApiErrorPanel error={error} /> : null}{children}</>}
		</SafeAreaScreen>
	);
}
