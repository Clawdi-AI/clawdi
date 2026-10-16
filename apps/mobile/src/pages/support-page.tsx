import { CLAWDI_HELP_COPY, resolveChatwootIdentity, settingsCopy } from "@clawdi/shared/view";
import { useQuery } from "@tanstack/react-query";
import { useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { WebView } from "react-native-webview";
import { useUniwind } from "uniwind";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { RouteLoadingSkeleton } from "@/components/route-loading-skeleton";
import { SheetPage } from "@/components/ui/sheet-page";
import { AppView } from "@/components/ui/view";
import { useMobileApi } from "@/lib/api-provider";
import {
	chatwootWidgetScript,
	chatwootWidgetUrl,
	isChatwootCloseMessage,
	isChatwootWidgetUrl,
	type SupportChatParams,
	supportChatContext,
} from "@/lib/chatwoot";
import { useMobileRuntimeConfig } from "@/lib/config/runtime";
import { useI18n } from "@/lib/i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useCurrentUser } from "@/platform/auth/auth-client";
import { openBrowserLink } from "@/platform/native-intent";
import { useSheet } from "@/platform/navigation/use-sheet";

/**
 * Web's Chatwoot live chat as a native sheet. Like Web, the widget opens only for the
 * identified, server-validated contact. The WebView is incognito, so no conversation token
 * outlives the sheet; Chatwoot restores the contact's conversations from its identity.
 */
export default function SupportPage() {
	const t = useI18n();
	const params = useLocalSearchParams<SupportChatParams>();
	const runtime = useMobileRuntimeConfig();
	const chatwoot = runtime.ok ? runtime.value.chatwoot : undefined;
	const { supportChat } = useMobileApi();
	const scope = useAccountScope();
	const read = useAccountRead();
	const { user } = useCurrentUser();
	const { theme } = useUniwind();
	const sheet = useSheet({ fallback: "/settings" });
	const [widgetFailed, setWidgetFailed] = useState(false);
	const [attempt, setAttempt] = useState(0);
	const identity = user
		? resolveChatwootIdentity({
				id: user.id,
				fullName: user.fullName,
				primaryEmailAddress: user.primaryEmailAddress,
				imageUrl: user.imageUrl,
			})
		: null;
	const identifierHash = useQuery({
		queryKey: accountQueryKey(scope, "support-chat-identity"),
		queryFn: ({ signal }) =>
			read((lease) => {
				if (!supportChat) throw new Error("Live chat unavailable");
				return supportChat.getIdentifierHash(lease);
			}, signal),
		enabled: scope.isReady && Boolean(supportChat),
		staleTime: Number.POSITIVE_INFINITY,
		retry: false,
	});
	const retry = () => {
		setWidgetFailed(false);
		setAttempt((current) => current + 1);
		if (identifierHash.isError) void identifierHash.refetch();
	};
	const failed = widgetFailed || identifierHash.isError || !supportChat || !chatwoot || !identity;
	return (
		<SheetPage
			title={CLAWDI_HELP_COPY.liveChat}
			fallback="/settings"
			scroll={false}
			closeLabel={settingsCopy.done}
			sheet={sheet}
		>
			{failed ? (
				<AppView className="p-4">
					<ApiErrorPanel title={t("support.failed")} error={identifierHash.error} onRetry={retry} />
				</AppView>
			) : identifierHash.isPending || !identifierHash.data ? (
				<RouteLoadingSkeleton />
			) : (
				<WebView
					key={attempt}
					testID="support-chat-widget"
					source={{ uri: chatwootWidgetUrl(chatwoot) }}
					incognito
					injectedJavaScript={chatwootWidgetScript({
						identity,
						identifierHash: identifierHash.data,
						colorScheme: theme === "dark" ? "dark" : "light",
						context: supportChatContext(params),
					})}
					onShouldStartLoadWithRequest={(request) => {
						if (request.isTopFrame === false || isChatwootWidgetUrl(request.url, chatwoot.baseUrl))
							return true;
						void openBrowserLink(request.url).catch(() => undefined);
						return false;
					}}
					onMessage={(event) => {
						if (isChatwootCloseMessage(event.nativeEvent.data)) void sheet.close();
					}}
					onError={() => setWidgetFailed(true)}
					style={{ flex: 1, backgroundColor: "transparent" }}
				/>
			)}
		</SheetPage>
	);
}
