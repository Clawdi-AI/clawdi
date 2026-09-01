"use client";

import { isSearchQueryReady, SEARCH_QUERY_MAX_LENGTH } from "@clawdi/shared/consts";
import {
	keepPreviousData,
	useInfiniteQuery,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { ArrowDown, Clock, Hash, MessageSquare, Trash2, Zap } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { useSetBreadcrumbTitle } from "@/components/breadcrumb-title";
import { AgentInline } from "@/components/dashboard/agent-label";
import { DetailBackLink } from "@/components/detail/back-link";
import { DetailMeta, DetailNotFound, DetailPanel } from "@/components/detail/layout";
import { EmptyState } from "@/components/empty-state";
import { ModelBadge } from "@/components/meta/model-badge";
import { Stat } from "@/components/meta/stat";
import { PageHeader, PageHeaderSkeleton } from "@/components/page-header";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import { sessionAgentIdentityInput } from "@/components/sessions/session-agent-label";
import { SessionSearchNavigation } from "@/components/sessions/session-search-navigation";
import { SessionSidebar } from "@/components/sessions/session-sidebar";
import {
	SessionShareButton,
	SessionShareDialog,
	type SessionShareTarget,
} from "@/components/sessions/share-controls";
import { VirtualizedSessionTimelineList } from "@/components/sessions/virtualized-message-list";
import { TimeTooltip } from "@/components/time-tooltip";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { useSidebar } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
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
import {
	SESSION_DETAIL_GC_MS,
	SESSION_DETAIL_STALE_MS,
	SESSION_MESSAGES_GC_MS,
	SESSION_MESSAGES_STALE_MS,
	sessionDetailQueryKey,
} from "@/lib/session-queries";
import {
	type SessionSearchAnchor,
	type SessionTimelineCategory,
	type SessionTimelineView,
	sessionTimelineCategories,
	sessionTimelineIncludesMessages,
	sessionTimelineViewFromCategories,
	sessionTimelineViewLink,
} from "@/lib/session-search-anchor";
import { useDebouncedValue } from "@/lib/use-debounced";
import { cn, formatNumber, formatSessionSummary, relativeTime } from "@/lib/utils";

const SESSION_MESSAGE_PAGE_SIZE = 100;
const SESSION_MESSAGE_API_DIRECTION = "desc" as const;

const TIMELINE_FILTERS: readonly {
	category: SessionTimelineCategory;
	label: string;
}[] = [
	{ category: "user", label: "You" },
	{ category: "assistant", label: "Agent" },
	{ category: "tools", label: "Tools" },
];

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
			key={sessionId}
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
					queryClient.removeQueries({
						queryKey: sessionDetailQueryKey(sessionId),
						exact: true,
					});
					queryClient.removeQueries({
						queryKey: ["session-messages", sessionId],
					});
					queryClient.removeQueries({
						queryKey: ["session-permissions", sessionId],
					});
				},
				() => window.location.replace(sessionsHref),
			);
		},
		onError: (error) => {
			toast.error("Couldn't delete session", {
				description: normalizeApiError(error),
			});
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

	// Conversations use chronological order with the latest message at the
	// bottom. The API returns newest-first pages so opening a
	// long session only fetches its tail; the virtualized renderer reverses
	// the loaded window and preserves the viewport as older pages prepend.
	const [isTimelineAtBottom, setIsTimelineAtBottom] = useState(true);
	const [latestScrollRequestId, setLatestScrollRequestId] = useState(0);
	const [shareTarget, setShareTarget] = useState<SessionShareTarget>({
		scope: "session",
	});
	const [shareOpen, setShareOpen] = useState(false);
	const openShare = (target: SessionShareTarget) => {
		setShareTarget(target);
		setShareOpen(true);
	};
	const normalizedSearchQuery = searchQuery?.trim() ?? "";
	const rememberedSearchQueryRef = useRef(normalizedSearchQuery);
	const timelineCategories = sessionTimelineCategories(timelineView);
	const searchableTimeline = sessionTimelineIncludesMessages(timelineView);
	const effectiveSearchQuery = isSearchQueryReady(normalizedSearchQuery)
		? normalizedSearchQuery
		: "";
	const debouncedSearchValue = useDebouncedValue(effectiveSearchQuery, 250);
	const debouncedSearchQuery = effectiveSearchQuery ? debouncedSearchValue || undefined : undefined;

	// Paginated message fetch via the new `/messages` endpoint.
	// Long sessions (5k+ messages, 10+ MB JSON) used to ship the
	// whole blob in one shot and Markdown-render every turn,
	// which froze the page for seconds. Now we load 100 at a time
	// and explicit pagination controls request older pages on demand.
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
		isPlaceholderData: isContentPlaceholderData,
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
							view: "all",
							...(timelineView === "all" ? {} : { include: timelineCategories }),
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
	const notifiedStaleAnchorRef = useRef<string | null>(null);
	const searchNavigation = pagesData?.pages[0]?.search_navigation;
	const resolvedSearchAnchor = searchNavigation?.current ?? searchAnchor;
	const anchorIdentity = resolvedSearchAnchor
		? `${resolvedSearchAnchor.kind}:${resolvedSearchAnchor.position}:${resolvedSearchAnchor.revision}`
		: null;
	const highlightScrollRequestKey =
		!isContentPlaceholderData && anchorIdentity && highlightedMessageKey
			? JSON.stringify([
					anchorIdentity,
					highlightedMessageKey,
					debouncedSearchQuery ?? null,
					timelineView,
				])
			: null;

	useEffect(() => {
		if (!anchorIdentity || !pagesData || isContentPlaceholderData || highlightedMessageKey) {
			return;
		}
		if (notifiedStaleAnchorRef.current !== anchorIdentity) {
			notifiedStaleAnchorRef.current = anchorIdentity;
			toast.info("Search result changed", {
				description: "This Session has newer content, so the conversation opened normally.",
			});
		}
	}, [anchorIdentity, highlightedMessageKey, isContentPlaceholderData, pagesData]);

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
	const isSearchDebouncing = effectiveSearchQuery !== (debouncedSearchQuery ?? "");
	const isTimelineTransitioning =
		isSearchDebouncing || isContentPlaceholderData || (isContentFetching && !isFetchingNextPage);
	const isSearchUpdating = searchActive && (isTimelineTransitioning || isContentLoading);
	const navigateTimelineView = (selected: SessionTimelineView, retainedSearchQuery?: string) => {
		if (agentId) {
			const search = {
				...(retainedSearchQuery ? { matchQuery: retainedSearchQuery } : {}),
				...(selected === "all" ? {} : { timelineView: selected }),
				...(returnTo ? { returnTo } : {}),
			};
			return router.navigate({
				...agentSessionDetailLink(agentId, sessionId, search),
				replace: true,
				resetScroll: false,
			});
		}
		return router.navigate({
			...sessionTimelineViewLink(sessionId, selected, {
				returnTo,
				searchQuery: retainedSearchQuery,
			}),
			replace: true,
			resetScroll: false,
		});
	};
	const updateTimelineView = (selected: SessionTimelineView) => {
		if (searchableTimeline) {
			rememberedSearchQueryRef.current = normalizedSearchQuery;
		}
		const retainedSearchQuery = !sessionTimelineIncludesMessages(selected)
			? undefined
			: normalizedSearchQuery || rememberedSearchQueryRef.current || undefined;
		void navigateTimelineView(selected, retainedSearchQuery);
	};
	const updateTimelineCategory = (category: SessionTimelineCategory, included: boolean) => {
		const categories = included
			? [...timelineCategories, category]
			: timelineCategories.filter((value) => value !== category);
		const selected = sessionTimelineViewFromCategories(categories);
		if (selected) updateTimelineView(selected);
	};
	const jumpToLatest = () => {
		if (pagesData?.pages[0]?.offset === 0) {
			setLatestScrollRequestId((requestId) => requestId + 1);
			return;
		}
		rememberedSearchQueryRef.current = "";
		void navigateTimelineView(timelineView).then(
			() => setLatestScrollRequestId((requestId) => requestId + 1),
			() => {
				rememberedSearchQueryRef.current = normalizedSearchQuery;
				toast.error("Couldn't open latest messages");
			},
		);
	};

	return (
		<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, "space-y-5 px-4 lg:px-6")}>
			<DetailBackLink href={sessionsHref} label="Sessions" />
			{/* Keep context visible when the timeline opens at its latest message. */}
			<div
				data-testid="session-context-header"
				className="sticky top-(--header-height) z-10 -mx-4 border-b bg-background/95 px-4 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/80 lg:-mx-6 lg:px-6"
			>
				<PageHeader
					className="gap-2"
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
								new Date(session.last_activity_at).getTime() -
									new Date(session.started_at).getTime(),
							) >
							5 * 60_000 ? (
								<>
									<span>·</span>
									<TimeTooltip value={session.last_activity_at}>
										<span>Last activity {relativeTime(session.last_activity_at)}</span>
									</TimeTooltip>
								</>
							) : null}
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
						</DetailMeta>
					}
					actions={
						<div className="flex items-center gap-2">
							<SessionShareButton onClick={() => openShare({ scope: "session" })} />
							<ConfirmAction
								title="Permanently delete this cloud Session?"
								description={
									<>
										<p>
											This permanently deletes the cloud Session, its history, and all sharing
											access.
										</p>
										<p>
											Local agent files remain untouched, but this Session will never sync again.
										</p>
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

				{session.has_content ? (
					<div className="mt-2">
						<div
							className={cn(
								"grid min-w-0 gap-2 md:items-center",
								searchableTimeline ? "md:grid-cols-[minmax(16rem,1fr)_auto]" : "md:grid-cols-1",
							)}
						>
							{searchableTimeline ? (
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
							) : null}
							<div
								className={cn(
									"flex min-h-9 min-w-0 items-center justify-between gap-2 md:justify-end",
									!searchableTimeline && "md:justify-self-end",
								)}
							>
								<fieldset className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
									<legend className="sr-only">Show in timeline</legend>
									{TIMELINE_FILTERS.map(({ category, label }) => {
										const checked = timelineCategories.includes(category);
										const disabled = checked && timelineCategories.length === 1;
										const id = `timeline-filter-${category}`;
										return (
											<div key={category} className="flex items-center gap-1.5">
												<Checkbox
													id={id}
													checked={checked}
													disabled={disabled}
													onCheckedChange={(value) =>
														updateTimelineCategory(category, value === true)
													}
												/>
												<Label htmlFor={id} className="cursor-pointer text-xs font-normal">
													{label}
												</Label>
											</div>
										);
									})}
								</fieldset>
								{!searchActive && loadedCount > 0 && loadedCount < totalItems ? (
									<span className="shrink-0 text-xs tabular-nums text-muted-foreground">
										{loadedCount} of {totalItems}
									</span>
								) : null}
							</div>
						</div>
					</div>
				) : null}
			</div>

			<SessionSidebar relatedRefs={session.related_refs} />

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
						{hasNextPage ? (
							<LoadMoreControl
								loadedCount={loadedCount}
								totalCount={totalItems}
								isFetching={isFetchingNextPage}
								onLoad={loadMoreMessages}
								label="Load earlier"
							/>
						) : null}
						<VirtualizedSessionTimelineList
							items={timelineItems}
							itemKeys={timelineKeys}
							agentType={session.agent_type}
							userAvatar={user?.imageUrl}
							userName={user?.fullName || "You"}
							highlightedMessageKey={highlightedMessageKey}
							highlightScrollRequestKey={highlightScrollRequestKey}
							highlightQuery={debouncedSearchQuery}
							totalItemCount={totalItems}
							windowStartOffset={pagesData?.pages[0]?.offset ?? 0}
							onAtBottomChange={setIsTimelineAtBottom}
							latestScrollRequestId={latestScrollRequestId}
							onShareMessage={openShare}
						/>
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

			{/* The conversation is always chronological, so leaving its
			    bottom makes the latest message available as a direct jump. */}
			{timelineItems &&
			timelineItems.length > 0 &&
			!isTimelineAtBottom &&
			!isTimelineTransitioning ? (
				<JumpToBottomButton onJump={jumpToLatest} />
			) : null}

			<SessionShareDialog
				sessionId={session.id}
				target={shareTarget}
				open={shareOpen}
				onOpenChange={setShareOpen}
			/>
		</div>
	);
}

/**
 * Floating "jump to bottom" button. Mirrors Slack / Discord / Linear
 * comment threads — when you've scrolled up in a long conversation,
 * the latest message becomes hard to find.
 *
 * Visibility and positioning both follow Virtuoso's viewport state. The
 * button emits a request; Virtuoso remains the sole owner of scrolling.
 */
function JumpToBottomButton({ onJump }: { onJump: () => void }) {
	const { state: sidebarState } = useSidebar();

	return (
		<div
			className={cn(
				"pointer-events-none fixed inset-x-0 bottom-6 z-20 flex justify-center md:right-2",
				sidebarState === "expanded"
					? "md:left-[calc(var(--clawdi-rail-width)+var(--sidebar-width))]"
					: "md:left-[calc(var(--clawdi-rail-width)+var(--spacing)*2)]",
			)}
		>
			<Button
				type="button"
				variant="secondary"
				size="sm"
				className="pointer-events-auto shadow-md"
				onClick={onJump}
			>
				<ArrowDown className="size-4" />
				Jump to latest
			</Button>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/**
 * Explicit history pagination. Keeping the request user-initiated avoids
 * repeatedly loading pages while a prepended timeline remains at its edge.
 */
function LoadMoreControl({
	loadedCount,
	totalCount,
	isFetching,
	onLoad,
	label,
}: {
	loadedCount: number;
	totalCount: number;
	isFetching: boolean;
	onLoad: () => void;
	label: string;
}) {
	return (
		<div className="flex flex-col items-center gap-2 py-4">
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
