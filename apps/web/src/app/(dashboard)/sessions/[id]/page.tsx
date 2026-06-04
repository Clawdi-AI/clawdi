"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
	ArrowDown,
	ArrowDownNarrowWide,
	ArrowUpNarrowWide,
	Clock,
	Hash,
	MessageSquare,
	Zap,
} from "lucide-react";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSetBreadcrumbTitle } from "@/components/breadcrumb-title";
import { AgentInline } from "@/components/dashboard/agent-label";
import { DetailMeta, DetailPanel, DetailStats, DetailTitle } from "@/components/detail/layout";
import { EmptyState } from "@/components/empty-state";
import { ModelBadge } from "@/components/meta/model-badge";
import { Stat } from "@/components/meta/stat";
import { MessageList } from "@/components/sessions/message-list";
import { SessionSidebar } from "@/components/sessions/session-sidebar";
import { SessionShareControls } from "@/components/sessions/share-controls";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, unwrap, useApi } from "@/lib/api";
import type { SessionMessage } from "@/lib/api-schemas";
import { useCurrentUser } from "@/lib/auth-client";
import { formatDuration } from "@/lib/format";
import {
	cn,
	formatAbsoluteTooltip,
	formatNumber,
	formatSessionSummary,
	relativeTime,
} from "@/lib/utils";

export default function SessionDetailPage() {
	const { id } = useParams<{ id: string }>();
	const api = useApi();
	const { user } = useCurrentUser();

	const { data: session, isLoading: isSessionLoading } = useQuery({
		queryKey: ["session", id],
		queryFn: async () =>
			unwrap(await api.GET("/api/sessions/{session_id}", { params: { path: { session_id: id } } })),
		// Don't retry 4xx (malformed UUID, not-found, unauthorized) — they won't
		// recover on retry and the default 3× retry makes the page hang in
		// "Loading..." for seconds before the user learns the URL is bogus.
		retry: (failureCount, err) => {
			const status = err instanceof ApiError ? err.status : 0;
			if (status >= 400 && status < 500) return false;
			return failureCount < 2;
		},
	});

	// Direction toggle: "desc" (newest-first, default) is the most
	// common review case for clawdi — users open a session to see
	// "what happened recently". For 5000-message sessions, the old
	// asc default forced the user to "Load more" through every page
	// just to reach today's messages. Defaulting desc + persisting
	// the user's choice in localStorage matches Slack/Discord (they
	// scroll-to-bottom on open) without requiring a scroll gesture
	// to find the latest reply.
	type Direction = "asc" | "desc";
	const [direction, setDirection] = useState<Direction>(() => {
		if (typeof window === "undefined") return "desc";
		const stored = localStorage.getItem("clawdi.session.message-direction");
		return stored === "asc" ? "asc" : "desc";
	});
	const persistDirection = (d: Direction) => {
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
	// and the IntersectionObserver in `LoadMoreSentinel` requests
	// the next page when the user scrolls near the bottom.
	//
	// Direction-aware pagination:
	//   - asc: classic "load older first, append newer". pageParam
	//     is the offset to fetch starting from 0.
	//   - desc: load NEWEST page first, append progressively-older
	//     pages as the user scrolls down. pageParam is the offset
	//     of the slice to fetch (counted from 0 in canonical order
	//     — the server endpoint is direction-agnostic). We compute
	//     it from `session.message_count` so we don't need a
	//     separate "total" round-trip.
	const PAGE_SIZE = 100;
	const totalForPaging = session?.message_count ?? 0;
	// Page param carries both offset AND limit so the final desc
	// page can shrink limit to fill exactly the items below the
	// previous offset. A flat limit=PAGE_SIZE on the last page would
	// re-fetch the tail of page-2 whenever total isn't a multiple
	// of PAGE_SIZE (e.g. total=250: p2 covers 50..149, p3 with
	// offset=0 limit=100 would re-cover 50..99).
	type PageParam = { offset: number; limit: number };
	const initialDescOffset = Math.max(0, totalForPaging - PAGE_SIZE);
	// Backend rejects limit=0 (Query(ge=1)), so clamp ≥ 1 for the
	// has_content=true + message_count=0 case (uploaded empty array).
	const initialDescLimit = Math.max(1, totalForPaging - initialDescOffset);
	const {
		data: pagesData,
		isLoading: isContentLoading,
		isError: isContentError,
		fetchNextPage,
		hasNextPage,
		isFetchingNextPage,
	} = useInfiniteQuery({
		// Direction in queryKey so toggling refetches from the new
		// end (rather than reordering already-loaded pages, which
		// would only show the OLDEST 100 in newest-first mode —
		// confusing).
		queryKey: ["session-messages", id, direction],
		initialPageParam:
			direction === "desc"
				? ({ offset: initialDescOffset, limit: initialDescLimit } as PageParam)
				: ({ offset: 0, limit: PAGE_SIZE } as PageParam),
		queryFn: async ({ pageParam }) => {
			const { offset, limit } = pageParam as PageParam;
			return unwrap(
				await api.GET("/api/sessions/{session_id}/messages", {
					params: {
						path: { session_id: id },
						query: { offset, limit },
					},
				}),
			);
		},
		getNextPageParam: (last): PageParam | undefined => {
			if (direction === "asc") {
				const nextOffset = last.offset + last.items.length;
				if (nextOffset >= last.total) return undefined;
				return { offset: nextOffset, limit: PAGE_SIZE };
			}
			// desc: previous page covered [last.offset, last.offset +
			// items.length). Next-older page ends EXACTLY at
			// last.offset, so limit = (last.offset - nextOffset) — no
			// overlap, no truncation.
			if (last.offset === 0) return undefined;
			const nextOffset = Math.max(0, last.offset - PAGE_SIZE);
			const nextLimit = last.offset - nextOffset;
			return { offset: nextOffset, limit: nextLimit };
		},
		enabled: !!session?.has_content,
		retry: (failureCount, err) => {
			const status = err instanceof ApiError ? err.status : 0;
			if (status >= 400 && status < 500) return false;
			return failureCount < 2;
		},
	});

	// Flatten pages → ordered message list, paired with a stable
	// React key per row. The key is the message's canonical position
	// (`page.offset + k`) so it stays put across pagination, direction
	// toggles, and refetches — array-index keys would break grouping
	// memo when prepended pages shift positions.
	const { messages, messageKeys } = useMemo(() => {
		if (!pagesData) return { messages: null, messageKeys: null };
		const msgs: SessionMessage[] = [];
		const keys: string[] = [];
		for (const page of pagesData.pages) {
			if (direction === "asc") {
				for (let k = 0; k < page.items.length; k++) {
					msgs.push(page.items[k]);
					keys.push(String(page.offset + k));
				}
			} else {
				for (let k = page.items.length - 1; k >= 0; k--) {
					msgs.push(page.items[k]);
					keys.push(String(page.offset + k));
				}
			}
		}
		return { messages: msgs, messageKeys: keys };
	}, [pagesData, direction]);
	const totalMessages = pagesData?.pages[0]?.total ?? 0;
	const loadedCount = messages?.length ?? 0;

	// Hooks must run on every render in the same order — this includes the
	// breadcrumb title hook. Compute the title (nullable while loading) and
	// register it BEFORE any early return; AppBreadcrumb's UUID fallback
	// handles the loading state in the meantime.
	const summaryText = session
		? formatSessionSummary(session.summary) || session.local_session_id.slice(0, 12)
		: null;
	useSetBreadcrumbTitle(summaryText);

	if (isSessionLoading) {
		return (
			<div className="space-y-5 px-4 lg:px-6">
				<DetailSkeleton />
			</div>
		);
	}

	if (!session || !summaryText) {
		return (
			<div className="space-y-5 px-4 lg:px-6">
				<p className="text-muted-foreground">Session not found.</p>
			</div>
		);
	}

	const totalTokens = (session.input_tokens ?? 0) + (session.output_tokens ?? 0);

	return (
		<div className="space-y-5 px-4 lg:px-6">
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0 flex-1 space-y-2">
					<DetailTitle>{summaryText}</DetailTitle>
					<DetailMeta>
						<AgentInline machineName={session.machine_name} type={session.agent_type} />
						{session.project_path ? (
							<>
								<span>·</span>
								<span className="truncate font-mono">{session.project_path}</span>
							</>
						) : null}
						<span>·</span>
						<span title={formatAbsoluteTooltip(session.started_at)}>
							Started {relativeTime(session.started_at)}
						</span>
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
								<span title={formatAbsoluteTooltip(session.last_activity_at)}>
									Last activity {relativeTime(session.last_activity_at)}
								</span>
							</>
						) : null}
					</DetailMeta>
				</div>
				<SessionShareControls sessionId={session.id} isShared={session.is_shared ?? false} />
			</div>

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

			{/* Direction toggle. Gated on `has_content` (not on
			    `messages.length`) so it stays visible while pages
			    are still loading. Status + flip control collapsed
			    onto one muted line — the date-divider below provides
			    the visual break between metadata and conversation,
			    so no separator above is needed. */}
			{session.has_content ? (
				<div className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
					{loadedCount > 0 ? (
						<span className="tabular-nums">
							{loadedCount}/{totalMessages}
						</span>
					) : null}
					<button
						type="button"
						onClick={() => persistDirection(direction === "desc" ? "asc" : "desc")}
						aria-label={
							direction === "desc" ? "Show oldest messages first" : "Show newest messages first"
						}
						className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-accent hover:text-accent-foreground transition-colors"
					>
						{direction === "desc" ? (
							<ArrowDownNarrowWide className="size-3.5" />
						) : (
							<ArrowUpNarrowWide className="size-3.5" />
						)}
						{direction === "desc" ? "Newest first" : "Oldest first"}
					</button>
				</div>
			) : null}

			{/* Messages */}
			{session.has_content ? (
				isContentLoading ? (
					<MessagesSkeleton />
				) : isContentError ? (
					<ContentFetchError />
				) : messages?.length ? (
					// Spacing comes from MessageBlock's `pt-4` on
					// group-start rows; continuation rows render flush
					// so a thread looks tight, not gapped.
					<div>
						<MessageList
							messages={messages}
							messageKeys={messageKeys}
							agentType={session.agent_type}
							userAvatar={user?.imageUrl}
							userName={user?.fullName || "You"}
						/>
						{hasNextPage ? (
							<LoadMoreSentinel
								loadedCount={loadedCount}
								totalCount={totalMessages}
								isFetching={isFetchingNextPage}
								onLoad={() => fetchNextPage()}
							/>
						) : null}
					</div>
				) : (
					<EmptyContent />
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
						fillHeight={false}
						description="Conversation not uploaded yet. To back-fill history from that machine, run: clawdi push --modules sessions --all-agents --all"
					/>
				</DetailPanel>
			)}

			{/* Floating "jump to bottom" — only meaningful in asc mode
			    where the newest message is at the bottom of a long
			    list. In desc mode the newest is already at the top,
			    so there's nothing to jump to. */}
			{direction === "asc" && messages && messages.length > 20 ? <JumpToBottomButton /> : null}
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
		// Find nearest scrollable ancestor. `overflow-y: auto` on
		// SidebarInset means it's the canonical scroller; falling
		// back to `window` if nothing matches keeps single-page
		// layouts (no sidebar) working.
		const findScrollableAncestor = (node: Element | null): HTMLElement | Window => {
			let cur = node?.parentElement ?? null;
			while (cur) {
				const overflow = getComputedStyle(cur).overflowY;
				if (overflow === "auto" || overflow === "scroll") return cur;
				cur = cur.parentElement;
			}
			return window;
		};
		const scroller = findScrollableAncestor(anchorRef.current);
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
 * Auto-loads the next page when the user scrolls within ~300px of
 * this sentinel. The IntersectionObserver fires on enter; we
 * de-bounce with `isFetching` so a fast scroll doesn't queue up
 * multiple requests for the same page. The button is also clickable
 * — gives the user manual control AND a fallback if the observer
 * fails (older browsers, headless render contexts, etc.).
 */
function LoadMoreSentinel({
	loadedCount,
	totalCount,
	isFetching,
	onLoad,
}: {
	loadedCount: number;
	totalCount: number;
	isFetching: boolean;
	onLoad: () => void;
}) {
	const ref = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		const node = ref.current;
		if (!node) return;
		if (typeof IntersectionObserver === "undefined") return;
		const observer = new IntersectionObserver(
			(entries) => {
				const entry = entries[0];
				if (entry?.isIntersecting && !isFetching) onLoad();
			},
			// Trigger 300px before the sentinel is fully in view —
			// keeps the scroll continuous instead of pausing while
			// the next page fetches.
			{ rootMargin: "300px" },
		);
		observer.observe(node);
		return () => observer.disconnect();
	}, [isFetching, onLoad]);

	return (
		<div ref={ref} className="flex flex-col items-center gap-2 py-4">
			<Button variant="ghost" size="sm" onClick={onLoad} disabled={isFetching}>
				{isFetching
					? `Loading more… (${loadedCount}/${totalCount})`
					: `Load more (${loadedCount}/${totalCount})`}
			</Button>
		</div>
	);
}

function DetailSkeleton() {
	return (
		<div className="space-y-5">
			<Skeleton className="h-5 w-64" />
			<Skeleton className="h-3.5 w-48" />
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

function EmptyContent() {
	return <EmptyState fillHeight={false} description="No messages in this session." />;
}

function ContentFetchError() {
	return (
		<EmptyState
			fillHeight={false}
			description="Session content is unavailable. Check your connection and refresh this page."
		/>
	);
}
