import {
	ApiClientError,
	buildSessionTimelineRows,
	DEFAULT_SESSION_TIMELINE_VIEW,
	type SessionDetailSearch,
	type SessionSearchAnchor,
	type SessionTimelineRow,
	sessionSearchAnchorFromSearch,
	sessionTimelineCategories,
	sessionTimelineIncludesMessages,
	sessionTimelineViewFromCategories,
} from "@clawdi/shared/api";
import { isSearchQueryReady, SEARCH_QUERY_MAX_LENGTH } from "@clawdi/shared/consts";
import { checkboxClasses, sessionDetailClasses as styles } from "@clawdi/shared/ui";
import { sessionEmptyDescription, sessionTimelineFilters } from "@clawdi/shared/view";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronUp } from "lucide-react-native";
import { type ReactElement, useEffect, useRef, useState } from "react";
import { FlatList } from "react-native";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { EmptyState } from "@/components/empty-state";
import { SessionSidebar } from "@/components/sessions/session-sidebar";
import { MessagesSkeleton } from "@/components/sessions/skeleton";
import { TimelineRow } from "@/components/sessions/timeline-row";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { SearchInput } from "@/components/ui/search-input";
import { Text } from "@/components/ui/text";
import { AppPressable, AppView } from "@/components/ui/view";
import { WebText, WebView, webView } from "@/components/ui/web-layout";
import { isNotFound } from "@/hooks/cloud-inventory";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import {
	adjacentTimelineCursor,
	type TimelineCursor,
	timelinePage,
	timelineRequest,
} from "@/lib/timeline-state";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { SafeAreaScreen } from "@/platform/safe-area-screen";

type Props = {
	sessionId: string;
	header: ReactElement;
	search: SessionDetailSearch;
	agentType?: string | null;
	hasContent?: boolean;
	relatedRefs?: {
		prs?: string[] | null;
		repos?: string[] | null;
		branches?: string[] | null;
	} | null;
};
export function Transcript(props: Props) {
	const scope = useAccountScope();
	return (
		<TranscriptView
			key={`${scope.identity}:${scope.generation}:${props.sessionId}:${JSON.stringify(props.search)}`}
			{...props}
		/>
	);
}

function TranscriptView({
	sessionId,
	header,
	search,
	agentType,
	hasContent = true,
	relatedRefs,
}: Props) {
	const t = useI18n();
	const { cloud } = useMobileApi();
	const scope = useAccountScope();
	const read = useAccountRead();
	const client = useQueryClient();
	const [view, setView] = useState(search.timelineView ?? DEFAULT_SESSION_TIMELINE_VIEW);
	const [query, setQuery] = useState(search.matchQuery ?? "");
	const [draft, setDraft] = useState(query);
	useEffect(() => {
		const timer = setTimeout(() => setQuery(draft.trim()), 250);
		return () => clearTimeout(timer);
	}, [draft]);
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
		enabled: scope.isReady && hasContent,
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
		<SafeAreaScreen>
			<WebView recipe={styles.page} className="px-4 pt-4">
				<WebView recipe={styles.context}>
					{header}
					{hasContent ? (
						<WebView recipe={styles.controls}>
							<WebView recipe={styles.controlGrid}>
								{sessionTimelineIncludesMessages(view) ? (
									<SearchInput
										value={draft}
										placeholder={t("sessionDetail.searchPlaceholder")}
										ariaLabel={t("sessionDetail.search")}
										maxLength={SEARCH_QUERY_MAX_LENGTH}
										onChange={(value) => {
											setDraft(value);
											setAnchor(undefined);
											setDirection("asc");
										}}
									/>
								) : null}
								{draft && sessionTimelineIncludesMessages(view) ? (
									<WebView recipe={styles.actions}>
										<WebText recipe={styles.muted} accessibilityLiveRegion="polite">
											{!isSearchQueryReady(draft)
												? t("sessionDetail.searchMinimum")
												: messages.isFetching
													? t("sessionDetail.searching")
													: messages.isError
														? t("sessionDetail.unavailable")
														: navigation
															? `${navigation.index} / ${navigation.total}`
															: "0 / 0"}
										</WebText>
										<Button
											variant="ghost"
											size="icon-xs"
											accessibilityLabel={t("sessionDetail.previous")}
											disabled={!navigation?.previous || messages.isFetching || messages.isError}
											onPress={() => selectMatch(navigation?.previous)}
										>
											<Icon as={ChevronUp} />
										</Button>
										<Button
											variant="ghost"
											size="icon-xs"
											accessibilityLabel={t("sessionDetail.next")}
											disabled={!navigation?.next || messages.isFetching || messages.isError}
											onPress={() => selectMatch(navigation?.next)}
										>
											<Icon as={ChevronDown} />
										</Button>
										{matchIndex >= 0 ? (
											<Button variant="ghost" size="sm" onPress={jumpToMatch}>
												<Text>{t("sessionDetail.match")}</Text>
											</Button>
										) : null}
									</WebView>
								) : null}
								<WebView recipe={styles.toolbar}>
									<WebView
										recipe={styles.filters}
										accessibilityLabel={t("sessionDetail.timelineLabel")}
									>
										{sessionTimelineFilters.map(({ category, label }) => {
											const categories = sessionTimelineCategories(view);
											const checked = categories.includes(category);
											const disabled = checked && categories.length === 1;
											return (
												<AppPressable
													key={category}
													className={webView(styles.filter)}
													accessibilityRole="checkbox"
													accessibilityLabel={label}
													accessibilityState={{ checked, disabled }}
													hitSlop={8}
													disabled={disabled}
													onPress={() => {
														const next = sessionTimelineViewFromCategories(
															checked
																? categories.filter((value) => value !== category)
																: [...categories, category],
														);
														if (next) {
															setView(next);
															setAnchor(undefined);
														}
													}}
												>
													<WebView
														recipe={checkboxClasses.root}
														state={{ "data-checked": checked }}
													>
														{checked ? <Icon as={Check} /> : null}
													</WebView>
													<WebText recipe={styles.filterLabel}>{label}</WebText>
												</AppPressable>
											);
										})}
									</WebView>
								</WebView>
							</WebView>
						</WebView>
					) : null}
				</WebView>
			</WebView>
			<FlatList
				key={windowKey}
				ref={list}
				maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
				data={rows}
				keyExtractor={(row) => String(row.rowKey)}
				contentContainerStyle={{
					paddingHorizontal: 16,
					paddingTop: 16,
					paddingBottom: 24,
					flexGrow: 1,
				}}
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
					<WebView recipe={styles.page} className="px-0">
						<SessionSidebar relatedRefs={relatedRefs} />
						{messages.hasPreviousPage ? (
							<WebView recipe={styles.pagination}>
								<Button
									variant="ghost"
									size="sm"
									disabled={messages.isFetching || conflict}
									onPress={() => {
										if (scope.isCurrent()) void messages.fetchPreviousPage().catch(() => undefined);
									}}
								>
									<Text>{t(direction === "asc" ? "timeline.earlier" : "timeline.later")}</Text>
								</Button>
							</WebView>
						) : null}
					</WebView>
				}
				renderItem={({ item }) => (
					<TimelineRow
						row={item}
						sessionId={sessionId}
						agentType={agentType}
						highlighted={item.rowKey === highlightedKey}
						query={effectiveQuery}
						disabled={messages.isFetching || messages.isError}
					/>
				)}
				ListEmptyComponent={
					hasContent && !messages.isError ? (
						messages.isPending ? (
							<MessagesSkeleton />
						) : (
							<EmptyState variant="inset" description={sessionEmptyDescription(view)} />
						)
					) : !hasContent ? (
						<EmptyState
							variant="inset"
							title={t("sessionDetail.conversation")}
							description={t("sessionDetail.uploadHelp")}
						/>
					) : undefined
				}
				ListFooterComponent={
					<WebView recipe={styles.pagination}>
						{isNotFound(messages.error) ? (
							<WebText recipe={styles.muted}>{t("sessions.noMessages")}</WebText>
						) : conflict ? (
							<>
								<WebText recipe={styles.muted}>{t("sessions.revisionChanged")}</WebText>
								<Button
									variant="outline"
									size="sm"
									disabled={messages.isFetching}
									onPress={refresh}
								>
									<Text>{t("sessionDetail.refresh")}</Text>
								</Button>
							</>
						) : messages.isError ? (
							<ApiErrorPanel
								error={messages.error}
								title={t("sessionDetail.activityError")}
								onRetry={
									messages.isFetching
										? undefined
										: () =>
												void (
													messages.isFetchNextPageError
														? messages.fetchNextPage()
														: messages.isFetchPreviousPageError
															? messages.fetchPreviousPage()
															: messages.refetch()
												).catch(() => undefined)
								}
							/>
						) : null}
						{!conflict && messages.hasNextPage ? (
							<Button
								variant="ghost"
								size="sm"
								disabled={messages.isFetching}
								onPress={() => {
									if (scope.isCurrent()) void messages.fetchNextPage().catch(() => undefined);
								}}
							>
								<Text>
									{t(direction === "asc" ? "timeline.later" : "timeline.earlier")} ({entries.length}
									/{messages.data?.pages[0]?.total ?? 0})
								</Text>
							</Button>
						) : null}
						{direction === "desc" ? (
							<Button
								variant="ghost"
								size="sm"
								accessibilityLabel={t("sessionDetail.beginning")}
								onPress={() => {
									setAnchor(undefined);
									setQuery("");
									setDraft("");
									setDirection("asc");
								}}
							>
								<Icon as={ArrowUp} />
								<Text>{t("sessionDetail.beginning")}</Text>
							</Button>
						) : null}
					</WebView>
				}
			/>
			{rows.length && !effectiveQuery ? (
				<AppView
					pointerEvents="box-none"
					style={{ position: "absolute", bottom: 24, left: 0, right: 0, alignItems: "center" }}
				>
					<Button
						variant="secondary"
						size="sm"
						onPress={() => {
							setAnchor(undefined);
							setQuery("");
							setDraft("");
							setDirection("desc");
							list.current?.scrollToEnd({ animated: false });
						}}
					>
						<Icon as={ArrowDown} />
						<Text>{t("sessionDetail.latest")}</Text>
					</Button>
				</AppView>
			) : null}
		</SafeAreaScreen>
	);
}
