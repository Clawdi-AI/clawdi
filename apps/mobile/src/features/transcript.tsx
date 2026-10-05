import {
	ApiClientError,
	buildSessionTimelineRows,
	DEFAULT_SESSION_TIMELINE_VIEW,
	SESSION_TIMELINE_CATEGORIES,
	type SessionDetailSearch,
	type SessionSearchAnchor,
	type SessionTimelineRow,
	sessionSearchAnchorFromSearch,
	sessionTimelineCategories,
	sessionTimelineIncludesMessages,
	sessionTimelineViewFromCategories,
} from "@clawdi/shared/api";
import { isSearchQueryReady, SEARCH_QUERY_MAX_LENGTH } from "@clawdi/shared/consts";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactElement, useEffect, useRef, useState } from "react";
import { FlatList } from "react-native";
import { useI18n } from "../i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "../platform/account-lifecycle";
import { useMobileApi } from "../providers/api-provider";
import { ErrorState } from "../ui/feedback";
import { NativeButton, NativeSwitch } from "../ui/native-controls";
import { AppText, AppTextInput, AppView } from "../ui/primitives";
import { ReadScreen } from "../ui/read-screen";
import { isNotFound } from "./cloud-inventory";
import { TimelineRow } from "./timeline-row";
import {
	adjacentTimelineCursor,
	type TimelineCursor,
	timelinePage,
	timelineRequest,
} from "./timeline-state";

type Props = { sessionId: string; header: ReactElement; search: SessionDetailSearch };
export function Transcript(props: Props) {
	const scope = useAccountScope();
	return (
		<TranscriptView
			key={`${scope.identity}:${scope.generation}:${props.sessionId}:${JSON.stringify(props.search)}`}
			{...props}
		/>
	);
}

function TranscriptView({ sessionId, header, search }: Props) {
	const t = useI18n();
	const { cloud } = useMobileApi();
	const scope = useAccountScope();
	const read = useAccountRead();
	const client = useQueryClient();
	const [view, setView] = useState(search.timelineView ?? DEFAULT_SESSION_TIMELINE_VIEW);
	const [query, setQuery] = useState(search.matchQuery ?? "");
	const [draft, setDraft] = useState(query);
	const [anchor, setAnchor] = useState<SessionSearchAnchor | undefined>(() =>
		sessionSearchAnchorFromSearch(search),
	);
	const [direction, setDirection] = useState<"asc" | "desc">("asc");
	const effectiveQuery =
		sessionTimelineIncludesMessages(view) && isSearchQueryReady(query) ? query : undefined;
	const windowKey = JSON.stringify([view, effectiveQuery, anchor, direction]);
	const queryKey = accountQueryKey(
		scope,
		"cloud-session-timeline",
		sessionId,
		view,
		effectiveQuery,
		anchor,
		direction,
	);
	const initialPageParam: TimelineCursor = { offset: 0, limit: 50, initial: true };
	const messages = useInfiniteQuery({
		queryKey,
		initialPageParam,
		queryFn: ({ signal, pageParam }) =>
			read(
				async (s) =>
					timelinePage(
						await cloud.getSessionMessages(
							sessionId,
							timelineRequest(pageParam, view, effectiveQuery, anchor, direction),
							s,
						),
					),
				signal,
			),
		getNextPageParam: (page) => adjacentTimelineCursor(page),
		getPreviousPageParam: (page) => adjacentTimelineCursor(page, true),
		enabled: scope.isReady,
		retry: false,
	});
	const entries = messages.data?.pages.flatMap((page) => page.items) ?? [];
	if (direction === "desc") entries.reverse();
	const rows = buildSessionTimelineRows(
		entries,
		entries.map((entry) => `${entry.kind}:${entry.position}`),
	);
	const matchedPage = messages.data?.pages.find(
		(page) => page.anchor_offset !== undefined && page.anchor_offset !== null,
	);
	const matchedEntry = matchedPage?.items[(matchedPage.anchor_offset ?? 0) - matchedPage.offset];
	const highlightedKey = matchedEntry ? `${matchedEntry.kind}:${matchedEntry.position}` : undefined;
	const navigation = matchedPage?.search_navigation;
	const matchIndex = rows.findIndex((row) => row.rowKey === highlightedKey);
	const list = useRef<FlatList<SessionTimelineRow>>(null);
	const frame = useRef<number | undefined>(undefined);
	const jump = useRef<{ index: number; attempts: number } | undefined>(undefined);
	const jumped = useRef<string | undefined>(undefined);
	const automaticIndex =
		matchIndex >= 0 ? matchIndex : direction === "desc" && !effectiveQuery ? rows.length - 1 : -1;
	const automaticTarget =
		highlightedKey ?? (direction === "desc" && !effectiveQuery ? "latest" : undefined);
	const automaticKey = automaticTarget ? `${windowKey}:${automaticTarget}` : undefined;
	const jumpToMatch = () => {
		if (matchIndex < 0) return;
		jump.current = { index: matchIndex, attempts: 0 };
		list.current?.scrollToIndex({ index: matchIndex, animated: false, viewPosition: 0.3 });
	};
	useEffect(() => {
		if (automaticKey === undefined) jumped.current = undefined;
		if (automaticIndex >= 0 && automaticKey !== jumped.current) {
			jumped.current = automaticKey;
			jump.current = { index: automaticIndex, attempts: 0 };
			frame.current = requestAnimationFrame(() =>
				list.current?.scrollToIndex({ index: automaticIndex, animated: false, viewPosition: 0.3 }),
			);
		}
		return () => {
			if (frame.current !== undefined) cancelAnimationFrame(frame.current);
			jump.current = undefined;
		};
	}, [automaticKey, automaticIndex]);
	const conflict = messages.error instanceof ApiClientError && messages.error.status === 409;
	const refresh = () => {
		if (!messages.isFetching && scope.isCurrent())
			void client.resetQueries({ queryKey, exact: true }).catch(() => undefined);
	};
	const selectMatch = (next: SessionSearchAnchor | null | undefined) => {
		if (next && !messages.isFetching && scope.isCurrent()) setAnchor(next);
	};
	return (
		<ReadScreen>
			<FlatList
				key={windowKey}
				ref={list}
				maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
				data={rows}
				keyExtractor={(row) => String(row.rowKey)}
				contentContainerStyle={{ padding: 24, gap: 12, flexGrow: 1 }}
				initialNumToRender={8}
				windowSize={5}
				onScrollToIndexFailed={({ index, averageItemLength }) => {
					const pending = jump.current;
					if (!pending || pending.index !== index || pending.attempts >= 3) return;
					pending.attempts++;
					list.current?.scrollToOffset({ offset: averageItemLength * index, animated: false });
					frame.current = requestAnimationFrame(() => {
						if (jump.current === pending)
							list.current?.scrollToIndex({ index, animated: false, viewPosition: 0.3 });
					});
				}}
				refreshing={
					messages.isRefetching && !messages.isFetchingNextPage && !messages.isFetchingPreviousPage
				}
				onRefresh={refresh}
				ListHeaderComponent={
					<AppView className="gap-4 pb-3">
						{header}
						<AppText accessibilityRole="header" className="text-xl font-semibold text-foreground">
							{t("timeline.title")}
						</AppText>
						{SESSION_TIMELINE_CATEGORIES.map((category) => (
							<NativeSwitch
								key={category}
								label={t(`timeline.${category}`)}
								value={sessionTimelineCategories(view).includes(category)}
								onValueChange={(enabled) => {
									const categories = sessionTimelineCategories(view);
									const next = sessionTimelineViewFromCategories(
										enabled
											? [...categories, category]
											: categories.filter((value) => value !== category),
									);
									if (next) {
										setView(next);
										setAnchor(undefined);
									}
								}}
							/>
						))}
						{sessionTimelineIncludesMessages(view) ? (
							<>
								<AppTextInput
									accessibilityLabel={t("timeline.search")}
									placeholder={t("timeline.search")}
									value={draft}
									onChangeText={setDraft}
									maxLength={SEARCH_QUERY_MAX_LENGTH}
									autoCapitalize="none"
									autoCorrect={false}
									className="rounded-xl bg-card p-3 text-foreground"
								/>
								{draft.trim() && !isSearchQueryReady(draft) ? (
									<AppText accessibilityRole="alert">{t("sessionFilters.searchInvalid")}</AppText>
								) : null}
								<NativeButton
									label={t("timeline.find")}
									disabled={!!draft.trim() && !isSearchQueryReady(draft)}
									onPress={() => {
										setQuery(draft.trim());
										setAnchor(undefined);
										setDirection("asc");
									}}
								/>
							</>
						) : null}
						{effectiveQuery && !messages.isError ? (
							<AppText accessibilityLiveRegion="polite">
								{messages.isPending || messages.isFetching
									? t("loading.session")
									: navigation
										? `${t("timeline.match")}: ${navigation.index} / ${navigation.total}`
										: t("timeline.noMatch")}
							</AppText>
						) : null}
						{navigation ? (
							<>
								<NativeButton
									label={t("timeline.previous")}
									disabled={!navigation.previous || messages.isFetching || messages.isError}
									onPress={() => selectMatch(navigation.previous)}
								/>
								<NativeButton
									label={t("timeline.next")}
									disabled={!navigation.next || messages.isFetching || messages.isError}
									onPress={() => selectMatch(navigation.next)}
								/>
							</>
						) : null}
						{matchIndex >= 0 ? (
							<NativeButton label={t("timeline.jump")} onPress={jumpToMatch} />
						) : null}
						<NativeButton
							label={t("timeline.beginning")}
							onPress={() => {
								setAnchor(undefined);
								setQuery("");
								setDraft("");
								setDirection("asc");
							}}
						/>
						<NativeButton
							label={t("timeline.latest")}
							onPress={() => {
								setAnchor(undefined);
								setQuery("");
								setDraft("");
								setDirection("desc");
							}}
						/>
						{messages.hasPreviousPage ? (
							<NativeButton
								label={t(direction === "asc" ? "timeline.earlier" : "timeline.later")}
								disabled={messages.isFetching || conflict}
								onPress={() => {
									if (scope.isCurrent()) void messages.fetchPreviousPage();
								}}
							/>
						) : null}
					</AppView>
				}
				renderItem={({ item }) => (
					<TimelineRow
						row={item}
						sessionId={sessionId}
						highlighted={item.rowKey === highlightedKey}
						query={effectiveQuery}
						disabled={messages.isFetching || messages.isError}
					/>
				)}
				ListEmptyComponent={
					!messages.isError ? (
						<AppText>{t(messages.isPending ? "loading.session" : "timeline.empty")}</AppText>
					) : undefined
				}
				ListFooterComponent={
					<AppView className="gap-3 py-4">
						{isNotFound(messages.error) ? (
							<AppText>{t("sessions.noMessages")}</AppText>
						) : conflict ? (
							<AppText>{t("sessions.revisionChanged")}</AppText>
						) : messages.isError ? (
							<ErrorState
								onRetry={
									messages.isFetching
										? undefined
										: () =>
												void (messages.isFetchNextPageError
													? messages.fetchNextPage()
													: messages.isFetchPreviousPageError
														? messages.fetchPreviousPage()
														: messages.refetch())
								}
							/>
						) : null}
						<AppText>
							{t("timeline.loaded")}: {entries.length} / {messages.data?.pages[0]?.total ?? 0}
						</AppText>
						{conflict ? (
							<NativeButton
								label={t("inventory.refresh")}
								disabled={messages.isFetching}
								onPress={refresh}
							/>
						) : messages.hasNextPage ? (
							<NativeButton
								label={t(direction === "asc" ? "timeline.later" : "timeline.earlier")}
								disabled={messages.isFetching}
								onPress={() => {
									if (scope.isCurrent()) void messages.fetchNextPage();
								}}
							/>
						) : null}
					</AppView>
				}
			/>
		</ReadScreen>
	);
}
