import { detailLayoutClasses } from "@clawdi/shared/ui";
import { type Href, router } from "expo-router";
import { ArrowLeft } from "lucide-react-native";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { AppScrollView } from "@/components/ui/view";
import { WebView, webView } from "@/components/ui/web-layout";
import { ReadScreen } from "@/platform/safe-area-screen";
export function LibraryPage({
	children,
	detail = false,
}: {
	children: ReactNode;
	detail?: boolean;
}) {
	return (
		<ReadScreen>
			<AppScrollView
				keyboardShouldPersistTaps="handled"
				contentContainerClassName={webView(
					detail ? detailLayoutClasses.detailPage : detailLayoutClasses.page,
				)}
			>
				{children}
			</AppScrollView>
		</ReadScreen>
	);
}
export function DetailPanel({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<WebView recipe={detailLayoutClasses.panel} className={className}>
			{children}
		</WebView>
	);
}
export function DetailMeta({ children }: { children: ReactNode }) {
	return <WebView recipe={detailLayoutClasses.meta}>{children}</WebView>;
}
export function DetailBackLink({ href, label }: { href: Href; label: string }) {
	return (
		<Button
			variant="ghost"
			size="sm"
			className={webView(detailLayoutClasses.back)}
			onPress={() => (router.canGoBack() ? router.back() : router.replace(href))}
		>
			<Icon as={ArrowLeft} />
			<Text>Back to {label}</Text>
		</Button>
	);
}
