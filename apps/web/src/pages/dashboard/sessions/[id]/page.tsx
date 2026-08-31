"use client";

import { isSearchQueryReady, SEARCH_QUERY_MAX_LENGTH } from "@clawdi/shared/consts";
import {
	keepPreviousData,
	useInfiniteQuery,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import {
	ArrowDown,
	ArrowDownNarrowWide,
	ArrowUpNarrowWide,
	Bot,
	Clock,
	Hash,
	MessageSquare,
	Trash2,
	UserRound,
	Wrench,
	Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { useSetBreadcrumbTitle } from "@/components/breadcrumb-title";
import { AgentInline } from "@/components/dashboard/agent-label";
import { DetailBackLink } from "@/components/detail/back-link";
import { DetailMeta, DetailNotFound, DetailPanel, DetailStats } from "@/components/detail/layout";
import { EmptyState } from "@/components/empty-state";
import { ModelBadge } from "@/components/meta/model-badge";
import { Stat } from "@/components/meta/stat";
import { PageHeader, PageHeaderSkeleton } from "@/components/page-header";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import { sessionAgentIdentityInput } from "@/components/sessions/session-agent-label";
import { SessionSearchNavigation } from "@/components/sessions/session-search-navigation";
import { SessionSidebar } from "@/components/sessions/session-sidebar";
import { SessionShareControls } from "@/components/sessions/share-controls";
import { VirtualizedSessionTimelineList } from "@/components/sessions/virtualized-message-list";
import { TimeTooltip } from "@/components/time-tooltip";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { agentDetailQueryOptions } from "@/lib/agent-queries";
import { agentSectionHref, agentSessionDetailLink } from "@/lib/agent-routes";
import { ApiError, unwrap, useApi, useOpenApi } from "@/lib/api";
import { isApiNotFoundError, normalizeApiError } from "@/lib/api-errors";
import type {
	SessionMessagesPage,
	SessionTimelineItem,
	SessionTimelinePage,
} from "@/lib/api-schemas";
import { useCurrentUser } from "@/lib/auth-client";
import { formatDuration } from "@/lib/format";
import { shouldBlockQueryError } from "@/lib/query-state";
import { findScrollableContainer } from "@/lib/scroll-container";
import {
	SESSION_DETAIL_GC_MS,
	SESSION_DETAIL_STALE_MS,
	SESSION_MESSAGES_GC_MS,
	SESSION_MESSAGES_STALE_MS,
	sessionDetailQueryKey,
} from "@/lib/session-queries";
import {
	type SessionSearchAnchor,
	type SessionTimelineView,
	sessionTimelineViewLink,
} from "@/lib/session-search-anchor";
import { useDebouncedValue } from "@/lib/use-debounced";
import { useIsomorphicLayoutEffect } from "@/lib/use-isomorphic-layout-effect";
import { cn, formatNumber, formatSessionSummary, relativeTime } from "@/lib/utils";

const SESSION_MESSAGE_PAGE_SIZE = 100;
const SESSION_MESSAGE_API_DIRECTION = "desc" as const;
type SessionMessageDirection = "asc" | "desc";

function normalizeTimelinePage(
	page: SessionMessagesPage | SessionTimelinePage,
): SessionTimelinePage {
	return {
		...page,
		items: page.items.map((item, index): SessionTimelineItem => {
			if ("kind" in item) return item;
			return {
				...item,
				kind: "message",
				position: page.offset + index,
			};
		}),
	};
}

export default function SessionDetailPage({
	sessionId,
	searchAnchor,
	searchQuery,
	timelineView,
	returnTo,
}: {
	sessionId: string;
	searchAnchor?: SessionSearchAnchor;
	searchQuery?: string;
	timelineView: SessionTimelineView;
	returnTo?: string;
}) {
	return (
		<SessionDetailContent
			sessionId={sessionId}
			searchAnchor={searchAnchor}
			searchQuery={searchQuery}
			timelineView={timelineView}
			returnTo={returnTo}
		/>
	);
}

export function SessionDetailContent({
	sessionId,
	agentId,
	searchAnchor,
	searchQuery,
	timelineView = "all",
	returnTo,
}: {
	sessionId: string;
	agentId?: string | null;
	searchAnchor?: SessionSearchAnchor;
	searchQuery?: string;
	timelineView?: SessionTimelineView;
	returnTo?: string;
}) {
	const api = useApi();
	const $api = useOpenApi();
	const queryClient = useQueryClient();
	const router = useRouter();
	const { user } = useCurrentUser();
	const sessionsHref = agentId ? agentSectionHref(agentId, "sessions") : (returnTo ?? "/sessions");
	const deleteSession = $api.useMutation("delete", "/v1/sessions/{session_id}", {
		onSuccess: () => {
			toast.success("Cloud Session permanently deleted", {
				description: "Local data and extracted Memories remain. This Session will not sync again.",
			});
			void queryClient.invalidateQueries({
				queryKey: ["get", "/v1/memories"],
				refetchType: "none",
			});
			void queryClient.invalidateQueries({
				queryKey: ["get", "/v1/memories/{memory_id}"],
				refetchType: "none",
			});
			void queryClient.invalidateQueries({
				queryKey: ["get", "/v1/sessions"],
				refetchType: "none",
			});
			void queryClient.invalidateQueries({
				queryKey: ["get", "/v1/dashboard/stats"],
				refetchType: "none",
			});
			void router.navigate({ href: sessionsHref, replace: true }).then(
				() => {
					queryClient.removeQueries({ queryKey: sessionDetailQueryKey(sessionId), exact: true });
					queryClient.removeQueries({ queryKey: ["session-messages", sessionId] });
					queryClient.removeQueries({ queryKey: ["session-permissions", sessionId] });
				},
				() => window.location.replace(sessionsHref),
			);
		},
		onError: (error) => {
			toast.error("Couldn't delete session", { description: normalizeApiError(error) });
		},
	});
	const onDelete = () => deleteSession.mutateAsync({ params: { path: { session_id: sessionId } } });

	const {
		data: session,
		isLoading: isSessionLoading,
		error: sessionError,
		refetch: refetchSession,
	} = $api.useQuery(
		"get",
		"/v1/sessions/{session_id}",
		{
			params: { path: { session_id: sessionId } },
		},
		{
			// Don't retry 4xx (malformed UUID, not-found, unauthorized) — they won't
			// recover on retry and the default 3× retry makes the page hang in
			// "Loading..." for seconds before the user learns the URL is bogus.
			retry: (failureCount, err) => {
				const status = err instanceof ApiError ? err.status : 0;
				if (status >= 400 && status < 500) return false;
				return failureCount < 2;
			},
			staleTime: SESSION_DETAIL_STALE_MS,
			gcTime: SESSION_DETAIL_GC_MS,
		},
	);
	const { data: scopedAgent } = useQuery({
		...agentDetailQueryOptions($api, queryClient, agentId ?? ""),
		enabled: !!agentId,
	});

	// Conversations default to chronological order with the latest message
	// at the bottom. The API still returns newest-first pages so opening a
	// long session only fetches its tail; the virtualized renderer reverses
	// the loaded window and preserves the viewport as older pages prepend.
	// SSR and hydration must agree on the first render, so the stored
	// preference syncs in a layout effect instead of the state initializer.
	// Layout effects run before the messages query subscribes, so a stored
	// "desc" swaps the presentation before paint without a second fetch.
	const [direction, setDirection] = useState<SessionMessageDirection>("asc");
	const normalizedSearchQuery = searchQuery?.trim() ?? "";
	const rememberedSearchQueryRef = useRef(normalizedSearchQuery);
	const effectiveSearchQuery = isSearchQueryReady(normalizedSearchQuery)
		? normalizedSearchQuery
		: "";
	const debouncedSearchQuery = useDebouncedValue(effectiveSearchQuery, 250) || undefined;
	useIsomorphicLayoutEffect(() => {
		const stored = localStorage.getItem("clawdi.session.message-direction");
		if (stored === "desc") setDirection("desc");
	}, []);
	const persistDirection = (d: SessionMessageDirection) => {
		setDirection(d);
		try {
			localStorage.setItem("clawdi.session.message-direction", d);
		} catch {
			/* private mode / quota / non-browser — direction stays in-memory */
		}
	};

	// Paginated message fetch via the new `/messages` endpoint.
	// Long sessions (5k+ messages, 10+ MB JSON) used to ship the
	// whole blob in one shot and Markdown-render every turn,
	// which froze the page for seconds. Now we load 100 at a time
	// and the pagination controls request
	// the next page when the user approaches the older edge.
	//
	// Fetching newest-first is independent from presentation order. It avoids
	// walking every older page just to render the current end of the chat.
	const {
		data: pagesData,
		isLoading: isContentLoading,
		isError: isContentError,
		error: contentError,
		refetch: refetchContent,
		fetchNextPage,
		hasNextPage,
		isFetchingNextPage,
		isFetching: isContentFetching,
	} = useInfiniteQuery({
		queryKey: [
			"session-messages",
			sessionId,
			session?.content_hash ?? null,
			session?.event_head_hash ?? null,
			timelineView,
			searchAnchor?.kind ?? null,
			searchAnchor?.position ?? null,
			searchAnchor?.revision ?? null,
			debouncedSearchQuery ?? null,
		],
		initialPageParam: 0,
		queryFn: async ({ pageParam }) => {
			const page = unwrap(
				await api.GET("/v1/sessions/{session_id}/messages", {
					params: {
						path: { session_id: sessionId },
						query: {
							offset: pageParam,
							limit: SESSION_MESSAGE_PAGE_SIZE,
							direction: SESSION_MESSAGE_API_DIRECTION,
							view: timelineView,
							...(pageParam === 0 && searchAnchor
								? {
										anchor_kind: searchAnchor.kind,
										anchor_position: searchAnchor.position,
										anchor_revision: searchAnchor.revision,
									}
								: {}),
							...(pageParam === 0 && debouncedSearchQuery
								? { search_query: debouncedSearchQuery }
								: {}),
						},
					},
				}),
			);
			return normalizeTimelinePage(page);
		},
		getNextPageParam: (last): number | undefined => {
			const nextOffset = last.offset + last.items.length;
			return nextOffset < last.total ? nextOffset : undefined;
		},
		enabled: !!session?.has_content,
		retry: (failureCount, err) => {
			const status = err instanceof ApiError ? err.status : 0;
			if (status >= 400 && status < 500) return false;
			return failureCount < 2;
		},
		staleTime: SESSION_MESSAGES_STALE_MS,
		gcTime: SESSION_MESSAGES_GC_MS,
		placeholderData: keepPreviousData,
	});
	const loadMoreMessages = useCallback(() => {
		if (!isFetchingNextPage) void fetchNextPage();
	}, [fetchNextPage, isFetchingNextPage]);

	// Flatten pages → ordered message list, paired with a stable
	// React key per row. The key is the server page position
	// (`page.offset + k`) so it stays put when older pages prepend.
	const { timelineItems, timelineKeys } = useMemo(() => {
		if (!pagesData) return { timelineItems: null, timelineKeys: null };
		const items: SessionTimelineItem[] = [];
		const keys: string[] = [];
		for (const page of pagesData.pages) {
			for (let k = 0; k < page.items.length; k++) {
				items.push(page.items[k]);
				keys.push(`${SESSION_MESSAGE_API_DIRECTION}:${page.offset + k}`);
			}
		}
		return { timelineItems: items, timelineKeys: keys };
	}, [pagesData]);
	const totalItems = pagesData?.pages[0]?.total ?? 0;
	const loadedCount = timelineItems?.length ?? 0;
	const anchorOffset = pagesData?.pages[0]?.anchor_offset;
	const highlightedMessageKey =
		typeof anchorOffset === "number" ? `${SESSION_MESSAGE_API_DIRECTION}:${anchorOffset}` : null;
	const highlightedMessageRef = useRef<HTMLDivElement | null>(null);
	const handledAnchorRef = useRef<string | null>(null);
	const searchNavigation = pagesData?.pages[0]?.search_navigation;
	const resolvedSearchAnchor = searchNavigation?.current ?? searchAnchor;
	const anchorIdentity = resolvedSearchAnchor
		? `${resolvedSearchAnchor.kind}:${resolvedSearchAnchor.position}:${resolvedSearchAnchor.revision}`
		: null;

	useEffect(() => {
		if (!anchorIdentity || !pagesData) return;
		if (highlightedMessageKey) {
			const handled = `resolved:${highlightedMessageKey}:${anchorIdentity}`;
			if (handledAnchorRef.current === handled) return;
			handledAnchorRef.current = handled;
			const frame = requestAnimationFrame(() => {
				highlightedMessageRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
			});
			return () => cancelAnimationFrame(frame);
		}
		const handled = `stale:${anchorIdentity}`;
		if (handledAnchorRef.current !== handled) {
			handledAnchorRef.current = handled;
			toast.info("Search result changed", {
				description: "This Session has newer content, so the conversation opened normally.",
			});
		}
	}, [anchorIdentity, highlightedMessageKey, pagesData]);

	// Hooks must run on every render in the same order — this includes the
	// breadcrumb title hook. Compute the title (nullable while loading) and
	// register it BEFORE any early return; AppBreadcrumb's UUID fallback
	// handles the loading state in the meantime.
	const summaryText = session
		? formatSessionSummary(session.summary) || session.local_session_id.slice(0, 12)
		: null;
	const sessionAgentIdentity = session ? sessionAgentIdentityInput(session) : null;
	const detailAgentIdentity = scopedAgent ?? sessionAgentIdentity;
	useSetBreadcrumbTitle(summaryText);

	if (isSessionLoading) {
		return (
			<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, "space-y-5 px-4 lg:px-6")}>
				<DetailBackLink href={sessionsHref} label="Sessions" />
				<DetailSkeleton />
			</div>
		);
	}

	if (isApiNotFoundError(sessionError) || shouldBlockQueryError(sessionError, session)) {
		return (
			<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, "space-y-5 px-4 lg:px-6")}>
				<DetailBackLink href={sessionsHref} label="Sessions" />
				{isApiNotFoundError(sessionError) ? (
					<DetailNotFound title="Session not found" message="This session doesn't exist." />
				) : (
					<ApiErrorPanel
						error={sessionError}
						onRetry={() => {
							void refetchSession();
						}}
						title="Couldn't load session"
					/>
				)}
			</div>
		);
	}

	if (!session || !summaryText) {
		return (
			<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, "space-y-5 px-4 lg:px-6")}>
				<DetailBackLink href={sessionsHref} label="Sessions" />
				<DetailNotFound title="Session not found" message="This session doesn't exist." />
			</div>
		);
	}

	const totalTokens = (session.input_tokens ?? 0) + (session.output_tokens ?? 0);
	const searchActive = Boolean(effectiveSearchQuery);
	const isSearchUpdating =
		searchActive &&
		(effectiveSearchQuery !== debouncedSearchQuery ||
			(isContentFetching && !isFetchingNextPage) ||
			isContentLoading);
	const updateTimelineView = (selected: SessionTimelineView) => {
		if (timelineView !== "tools") {
			rememberedSearchQueryRef.current = normalizedSearchQuery;
		}
		const retainedSearchQuery =
			selected === "tools"
				? undefined
				: normalizedSearchQuery || rememberedSearchQueryRef.current || undefined;
		if (agentId) {
			const search = {
				...(retainedSearchQuery ? { matchQuery: retainedSearchQuery } : {}),
				...(selected === "all" ? {} : { timelineView: selected }),
			};
			void router.navigate({
				...agentSessionDetailLink(agentId, sessionId, search),
				replace: true,
				resetScroll: false,
			});
			return;
		}
		void router.navigate({
			...sessionTimelineViewLink(sessionId, selected, {
				returnTo,
				searchQuery: retainedSearchQuery,
			}),
			replace: true,
			resetScroll: false,
		});
	};

	return (
		<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, "space-y-5 px-4 lg:px-6")}>
			<DetailBackLink href={sessionsHref} label="Sessions" />
			<PageHeader
				title={summaryText}
				status={
					<DetailMeta>
						<AgentInline
							name={detailAgentIdentity?.name ?? null}
							displayName={detailAgentIdentity?.display_name ?? null}
							defaultName={detailAgentIdentity?.default_name ?? null}
							machineName={detailAgentIdentity?.machine_name ?? null}
							type={detailAgentIdentity?.agent_type ?? null}
						/>
						{session.project_path ? (
							<>
								<span>·</span>
								<span className="truncate font-mono">{session.project_path}</span>
							</>
						) : null}
						<span>·</span>
						<TimeTooltip value={session.started_at}>
							<span>Started {relativeTime(session.started_at)}</span>
						</TimeTooltip>
						{/* Surface "last activity" only when meaningfully
					    different from started_at (long-running sessions).
					    Threshold of 5 minutes — short sessions render
					    near-identical relative-time strings ("3h ago" /
					    "3h ago") which adds noise without information.
					    Above 5 minutes the relative bucket usually
					    diverges (e.g. "3h ago" vs "2h ago" or "yesterday"
					    vs "today") and the second stamp earns its space. */}
						{Math.abs(
							new Date(session.last_activity_at).getTime() - new Date(session.started_at).getTime(),
						) >
						5 * 60_000 ? (
							<>
								<span>·</span>
								<TimeTooltip value={session.last_activity_at}>
									<span>Last activity {relativeTime(session.last_activity_at)}</span>
								</TimeTooltip>
							</>
						) : null}
					</DetailMeta>
				}
				actions={
					<div className="flex items-center gap-2">
						<SessionShareControls sessionId={session.id} isShared={session.is_shared ?? false} />
						<ConfirmAction
							title="Permanently delete this cloud Session?"
							description={
								<>
									<p>
										This permanently deletes the cloud Session, its history, and all sharing access.
									</p>
									<p>Local agent files remain untouched, but this Session will never sync again.</p>
									<p>
										Extracted account-level Memories remain, with this Session&apos;s provenance
										removed.
									</p>
								</>
							}
							confirmLabel="Permanently delete"
							destructive
							onConfirm={onDelete}
						>
							<Button
								variant="outline"
								size="sm"
								disabled={deleteSession.isPending}
								className="w-fit shrink-0 text-destructive hover:text-destructive"
							>
								<Trash2 />
								Delete
							</Button>
						</ConfirmAction>
					</div>
				}
			/>

			<SessionSidebar relatedRefs={session.related_refs} />

			<DetailStats>
				<ModelBadge modelId={session.model} />
				<Stat icon={MessageSquare} label={`${session.message_count} messages`} />
				<Stat icon={Zap} label={`${formatNumber(totalTokens)} tokens`} />
				{session.duration_seconds ? (
					<Stat icon={Clock} label={formatDuration(session.duration_seconds)} />
				) : null}
				<Stat
					icon={Hash}
					label={session.local_session_id.slice(0, 8)}
					title={session.local_session_id}
				/>
			</DetailStats>

			{session.has_content ? (
				<div className="sticky top-(--header-height) z-10 -mx-4 border-b bg-background/95 px-4 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/80 lg:-mx-6 lg:px-6">
					<div
						className={cn(
							"grid min-w-0 gap-2 md:items-center",
							timelineView === "tools" ? "md:grid-cols-1" : "md:grid-cols-[minmax(16rem,1fr)_auto]",
						)}
					>
						{timelineView === "tools" ? null : (
							<SessionSearchNavigation
								sessionId={sessionId}
								agentId={agentId}
								query={normalizedSearchQuery}
								timelineView={timelineView}
								navigation={searchNavigation}
								returnTo={returnTo}
								isSearching={isSearchUpdating}
								hasSearchError={searchActive && isContentError}
								className="md:max-w-xl"
								maxLength={SEARCH_QUERY_MAX_LENGTH}
							/>
						)}
						<div
							className={cn(
								"flex min-h-9 min-w-0 items-center justify-between gap-2 md:justify-end",
								timelineView === "tools" && "md:justify-self-end",
							)}
						>
							<ToggleGroup
								value={[timelineView]}
								onValueChange={(values) => {
									const selected = values[0];
									if (
										selected === "all" ||
										selected === "user" ||
										selected === "assistant" ||
										selected === "tools"
									) {
										updateTimelineView(selected);
									}
								}}
								variant="outline"
								size="sm"
								spacing={0}
								aria-label="Timeline view"
								className="min-w-0"
							>
								<ToggleGroupItem value="all" aria-label="All activity" title="All activity">
									<MessageSquare /> <span className="hidden sm:inline">All</span>
								</ToggleGroupItem>
								<ToggleGroupItem value="user" aria-label="Your messages" title="Your messages">
									<UserRound /> <span className="hidden sm:inline">You</span>
								</ToggleGroupItem>
								<ToggleGroupItem
									value="assistant"
									aria-label="Agent messages"
									title="Agent messages"
								>
									<Bot /> <span className="hidden sm:inline">Agent</span>
								</ToggleGroupItem>
								<ToggleGroupItem value="tools" aria-label="Tools activity" title="Tool activity">
									<Wrench /> <span className="hidden sm:inline">Tools</span>
								</ToggleGroupItem>
							</ToggleGroup>
							<div className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
								{!searchActive && loadedCount > 0 && loadedCount < totalItems ? (
									<span className="tabular-nums">
										{loadedCount} of {totalItems}
									</span>
								) : null}
								<Button
									variant="ghost"
									size="icon-sm"
									onClick={() => persistDirection(direction === "desc" ? "asc" : "desc")}
									aria-label={
										direction === "desc"
											? "Show oldest activity first"
											: "Show newest activity first"
									}
									title={direction === "desc" ? "Newest first" : "Oldest first"}
								>
									{direction === "desc" ? <ArrowDownNarrowWide /> : <ArrowUpNarrowWide />}
								</Button>
							</div>
						</div>
					</div>
				</div>
			) : null}

			{/* Timeline */}
			{session.has_content ? (
				isContentLoading ? (
					<MessagesSkeleton />
				) : isContentError && shouldBlockQueryError(contentError, pagesData) ? (
					<ApiErrorPanel
						error={contentError}
						onRetry={() => {
							void refetchContent();
						}}
						title="Couldn't load activity"
					/>
				) : timelineItems?.length ? (
					<div>
						{direction === "asc" && hasNextPage ? (
							<LoadMoreControl
								loadedCount={loadedCount}
								totalCount={totalItems}
								isFetching={isFetchingNextPage}
								onLoad={loadMoreMessages}
								label="Load earlier"
								autoLoad={false}
							/>
						) : null}
						<VirtualizedSessionTimelineList
							items={timelineItems}
							itemKeys={timelineKeys}
							agentType={session.agent_type}
							userAvatar={user?.imageUrl}
							userName={user?.fullName || "You"}
							highlightedMessageKey={highlightedMessageKey}
							highlightedMessageRef={highlightedMessageRef}
							highlightQuery={debouncedSearchQuery}
							direction={direction}
							totalItemCount={totalItems}
							hasMoreItems={Boolean(hasNextPage)}
							isLoadingMore={isFetchingNextPage}
							onLoadMore={loadMoreMessages}
						/>
						{direction === "desc" && hasNextPage ? (
							<LoadMoreControl
								loadedCount={loadedCount}
								totalCount={totalItems}
								isFetching={isFetchingNextPage}
								onLoad={loadMoreMessages}
								label="Load older"
							/>
						) : null}
					</div>
				) : (
					<EmptyContent view={timelineView} />
				)
			) : (
				<DetailPanel className="space-y-4">
					<div className="space-y-1">
						<div className="flex items-center gap-2">
							<MessageSquare className="size-4 text-muted-foreground" />
							<h2 className="text-sm font-semibold">Conversation</h2>
						</div>
						<p className="text-xs text-muted-foreground">
							Messages appear here after the agent uploads this session.
						</p>
					</div>
					<EmptyState
						variant="inset"
						description="Conversation not uploaded yet. To back-fill history from that machine, run: clawdi push --modules sessions --all-agents --all"
					/>
				</DetailPanel>
			)}

			{/* Floating "jump to bottom" — only meaningful in asc mode
			    where the newest message is at the bottom of a long
			    list. In desc mode the newest is already at the top,
			    so there's nothing to jump to. */}
			{direction === "asc" && timelineItems && timelineItems.length > 20 ? (
				<JumpToBottomButton />
			) : null}
		</div>
	);
}

/**
 * Floating "jump to bottom" button. Mirrors Slack / Discord / Linear
 * comment threads — when you've scrolled up in a long conversation,
 * the latest message becomes hard to find.
 *
 * Scroll source: the dashboard's actual scroll container is
 * `SidebarInset` (with `overflow-y-auto`), NOT `window`. Listening
 * on `window` made the button invisible and `window.scrollTo`
 * scrolled the wrong target. We walk up the DOM looking for the
 * nearest scrollable ancestor at mount time, then bind there.
 */
function JumpToBottomButton() {
	const [visible, setVisible] = useState(false);
	const scrollerRef = useRef<HTMLElement | Window | null>(null);
	const anchorRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		const scroller = findScrollableContainer(anchorRef.current?.parentElement ?? null);
		scrollerRef.current = scroller;

		const onScroll = () => {
			let scrollBottom: number;
			if (scroller instanceof Window) {
				const doc = document.documentElement;
				scrollBottom = doc.scrollHeight - (window.scrollY + window.innerHeight);
			} else {
				scrollBottom = scroller.scrollHeight - (scroller.scrollTop + scroller.clientHeight);
			}
			setVisible(scrollBottom > 600);
		};
		onScroll();
		scroller.addEventListener("scroll", onScroll, { passive: true });
		return () => scroller.removeEventListener("scroll", onScroll);
	}, []);

	const onJump = () => {
		const scroller = scrollerRef.current;
		if (!scroller) return;
		if (scroller instanceof Window) {
			window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" });
		} else {
			scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
		}
	};

	return (
		<>
			{/* Anchor used at mount to locate the scrollable ancestor.
			    Hidden but stays in the DOM so the ref keeps pointing
			    at a valid node for the lifetime of the component. */}
			<div ref={anchorRef} aria-hidden className="hidden" />
			{visible ? (
				<Button
					type="button"
					variant="secondary"
					size="sm"
					className="fixed bottom-6 right-6 z-20 shadow-md"
					onClick={onJump}
				>
					<ArrowDown className="size-4" />
					Jump to latest
				</Button>
			) : null}
		</>
	);
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/**
 * Manual pagination fallback. Newest-first mode also observes this
 * bottom-edge control; chronological mode uses Virtuoso's `startReached`
 * so prepended rows retain their exact scroll position.
 */
function LoadMoreControl({
	loadedCount,
	totalCount,
	isFetching,
	onLoad,
	label,
	autoLoad = true,
}: {
	loadedCount: number;
	totalCount: number;
	isFetching: boolean;
	onLoad: () => void;
	label: string;
	autoLoad?: boolean;
}) {
	const ref = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		if (!autoLoad) return;
		const node = ref.current;
		if (!node) return;
		if (typeof IntersectionObserver === "undefined") return;
		const observer = new IntersectionObserver(
			(entries) => {
				const entry = entries[0];
				if (entry?.isIntersecting && !isFetching) onLoad();
			},
			// Trigger 300px before the control is fully in view —
			// keeps the scroll continuous instead of pausing while
			// the next page fetches.
			{ rootMargin: "300px" },
		);
		observer.observe(node);
		return () => observer.disconnect();
	}, [autoLoad, isFetching, onLoad]);

	return (
		<div ref={ref} className="flex flex-col items-center gap-2 py-4">
			<Button variant="ghost" size="sm" onClick={onLoad} disabled={isFetching}>
				{isFetching
					? `Loading… (${loadedCount}/${totalCount})`
					: `${label} (${loadedCount}/${totalCount})`}
			</Button>
		</div>
	);
}

function DetailSkeleton() {
	return (
		<div className="space-y-5">
			<PageHeaderSkeleton actions description={false} />
			<div className="flex gap-3">
				<Skeleton className="h-6 w-20 rounded-full" />
				<Skeleton className="h-4 w-24" />
				<Skeleton className="h-4 w-20" />
			</div>
			<Separator />
			<MessagesSkeleton />
		</div>
	);
}

function MessagesSkeleton() {
	return (
		<div className="space-y-6">
			{Array.from({ length: 4 }).map((_, i) => (
				<div key={i} className="flex gap-3">
					{i % 2 === 0 ? (
						<Skeleton className="size-7 rounded-full shrink-0" />
					) : (
						<div className="w-7 shrink-0" />
					)}
					<div className="flex-1 space-y-2">
						<Skeleton className="h-3.5 w-24" />
						<Skeleton className={cn("h-4", i % 2 === 0 ? "w-3/4" : "w-full")} />
						{i % 2 === 1 && <Skeleton className="h-20 w-full rounded-lg" />}
					</div>
				</div>
			))}
		</div>
	);
}

function EmptyContent({ view }: { view: SessionTimelineView }) {
	const description =
		view === "tools"
			? "No tool activity in this session."
			: view === "user"
				? "No user messages in this session."
				: view === "assistant"
					? "No agent messages in this session."
					: "No visible activity in this session.";
	return <EmptyState variant="inset" description={description} />;
}
