import { ApiClientError } from "@clawdi/shared/api";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { FlatList } from "react-native";
import { useI18n } from "../i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "../platform/account-lifecycle";
import { useMobileApi } from "../providers/api-provider";
import { ErrorState, LoadingScreen } from "../ui/feedback";
import { NativeButton } from "../ui/native-controls";
import { AppText, AppView } from "../ui/primitives";
import { ReadScreen } from "../ui/read-screen";
import { formatDate, isNotFound } from "./cloud-inventory";
import { limitedText, messagePage, nextMessageOffset } from "./read-helpers";

export function Transcript({ sessionId, header }: { sessionId: string; header: ReactElement }) {
	const t = useI18n();
	const { cloud } = useMobileApi();
	const scope = useAccountScope();
	const read = useAccountRead();
	const client = useQueryClient();
	const queryKey = accountQueryKey(scope, "cloud-session-messages", sessionId);
	const initialPageParam: { offset: number; revision: string | undefined } = {
		offset: 0,
		revision: undefined,
	};
	const messages = useInfiniteQuery({
		queryKey,
		initialPageParam,
		queryFn: ({ signal, pageParam }) =>
			read(
				async (readSignal) =>
					messagePage(
						await cloud.getSessionMessages(
							sessionId,
							{
								offset: pageParam.offset,
								limit: 50,
								direction: "asc",
								view: "messages",
								content_revision: pageParam.revision,
							},
							readSignal,
						),
					),
				signal,
			),
		getNextPageParam: (page) => {
			const offset = nextMessageOffset(page);
			return offset === undefined
				? undefined
				: { offset, revision: page.content_revision ?? undefined };
		},
		enabled: scope.isReady,
		retry: false,
	});
	const items =
		messages.data?.pages.flatMap((page) =>
			page.items.map((message, index) => ({ message, position: page.offset + index })),
		) ?? [];
	const conflict = messages.error instanceof ApiClientError && messages.error.status === 409;
	const refresh = () => {
		if (!messages.isFetching && scope.isCurrent())
			void client.resetQueries({ queryKey, exact: true }).catch(() => undefined);
	};
	return (
		<ReadScreen>
			<FlatList
				data={items}
				keyExtractor={(item) => String(item.position)}
				contentContainerStyle={{ padding: 24, gap: 12, flexGrow: 1 }}
				initialNumToRender={8}
				windowSize={5}
				refreshing={messages.isRefetching && !messages.isFetchingNextPage}
				onRefresh={refresh}
				ListHeaderComponent={
					<AppView className="gap-4 pb-3">
						{header}
						<AppText accessibilityRole="header" className="text-xl font-semibold text-foreground">
							{t("sessions.transcript")}
						</AppText>
						<AppText className="text-sm text-muted">
							{t("sessions.readOnly")} · {t("sessions.truncated")}
						</AppText>
					</AppView>
				}
				renderItem={({ item }) => (
					<AppView className="gap-2 rounded-2xl bg-surface p-4">
						<AppText className="text-base font-semibold text-foreground">
							{t(item.message.role === "user" ? "sessions.user" : "sessions.assistant")}
						</AppText>
						{formatDate(item.message.timestamp) ? (
							<AppText className="text-sm text-muted">{formatDate(item.message.timestamp)}</AppText>
						) : null}
						<AppText selectable className="text-base leading-6 text-foreground">
							{limitedText(item.message.content)}
						</AppText>
					</AppView>
				)}
				ListEmptyComponent={
					messages.isPending ? (
						<LoadingScreen label={t("loading.session")} />
					) : !messages.isError ? (
						<AppText className="text-base text-muted">{t("sessions.noMessages")}</AppText>
					) : undefined
				}
				ListFooterComponent={
					<AppView className="gap-3 py-4">
						{isNotFound(messages.error) ? (
							<AppText className="text-base text-muted">{t("sessions.noMessages")}</AppText>
						) : conflict ? (
							<AppText className="text-base text-muted">{t("sessions.revisionChanged")}</AppText>
						) : messages.isError ? (
							<ErrorState
								onRetry={
									messages.isFetching
										? undefined
										: () =>
												void (messages.isFetchNextPageError
													? messages.fetchNextPage()
													: messages.refetch())
								}
							/>
						) : null}
						<AppText className="text-sm text-muted">
							{t("sessions.loaded")}: {items.length} / {messages.data?.pages[0]?.total ?? 0}
						</AppText>
						{conflict ? (
							<NativeButton
								disabled={messages.isFetching}
								label={t("inventory.refresh")}
								onPress={refresh}
							/>
						) : messages.hasNextPage ? (
							<NativeButton
								disabled={messages.isFetching}
								label={t("inventory.loadMore")}
								onPress={() => {
									if (!messages.isFetching && scope.isCurrent()) void messages.fetchNextPage();
								}}
							/>
						) : null}
					</AppView>
				}
			/>
		</ReadScreen>
	);
}
