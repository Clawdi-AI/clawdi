import { detailLayoutClasses } from "@clawdi/shared/ui";
import type { Href } from "expo-router";
import { type ReactNode, useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { AppScrollView, AppView } from "@/components/ui/view";
import { WebText, webView } from "@/components/ui/web-layout";
import { useI18n } from "@/lib/i18n";
import type { HeaderAction } from "@/platform/navigation/native-header-types";
import { NativeHeader } from "@/platform/navigation/native-header";
import { useSheet } from "@/platform/navigation/use-sheet";
import { SafeAreaScreen } from "@/platform/safe-area-screen";

/** A route sheet has ordinary page content. The parent Stack owns its presentation. */
export function SheetPage({
	title,
	actions = [],
	description,
	children,
	fallback,
	busy = false,
	scroll = true,
	sheet: suppliedSheet,
}: {
	title: string;
	actions?: HeaderAction[];
	description?: ReactNode;
	children: ReactNode;
	fallback: Href;
	busy?: boolean;
	/** Disable when a NativeList owns the route content scroll. */
	scroll?: boolean;
	/** Pass the form's useSheet instance when it also closes with a mutation result. */
	sheet?: { close: () => Promise<void> };
}) {
	const t = useI18n();
	const defaultSheet = useSheet({ fallback, busy: suppliedSheet ? false : busy });
	const sheet = suppliedSheet ?? defaultSheet;
	const [error, setError] = useState<unknown>();
	const content = (
		<>
			{description ? <WebText recipe="text-sm text-muted-foreground">{description}</WebText> : null}
			{error ? <ApiErrorPanel error={error} /> : null}
			{children}
		</>
	);
	return (
		<SafeAreaScreen>
			<NativeHeader
				title={title}
				actions={[
					...actions,
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
			{scroll ? (
				<AppScrollView
					contentInsetAdjustmentBehavior="automatic"
					keyboardShouldPersistTaps="handled"
					contentContainerClassName={webView(detailLayoutClasses.detailPage)}
				>
					{content}
				</AppScrollView>
			) : (
				<AppView className="flex-1">{content}</AppView>
			)}
		</SafeAreaScreen>
	);
}
