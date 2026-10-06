import { detailLayoutClasses } from "@clawdi/shared/ui";
import { type Href, router } from "expo-router";
import { HeaderHeightContext } from "expo-router/react-navigation";
import { ArrowLeft } from "lucide-react-native";
import type { ReactNode } from "react";
import { useContext } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { AppScrollView } from "@/components/ui/view";
import { WebView, webView } from "@/components/ui/web-layout";
import { SafeAreaScreen } from "@/platform/safe-area-screen";
export function LibraryPage({
	children,
	detail = false,
}: {
	children: ReactNode;
	detail?: boolean;
}) {
	return (
		<SafeAreaScreen>
			<AppScrollView
				keyboardShouldPersistTaps="handled"
				contentInsetAdjustmentBehavior="automatic"
				contentContainerClassName={webView(
					detail ? detailLayoutClasses.detailPage : detailLayoutClasses.page,
				)}
			>
				{children}
			</AppScrollView>
		</SafeAreaScreen>
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
	const headerHeight = useContext(HeaderHeightContext);
	if (headerHeight) return null;
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
