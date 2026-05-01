"use client";

import { useUser } from "@clerk/nextjs";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
	ArrowDown,
	ArrowDownNarrowWide,
	ArrowUpNarrowWide,
	ChevronRight,
	Clock,
	Hash,
	MessageSquare,
	Terminal,
	Zap,
} from "lucide-react";
import Image from "next/image";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSetBreadcrumbTitle } from "@/components/breadcrumb-title";
import { AgentIcon } from "@/components/dashboard/agent-icon";
import { AgentInline, agentTypeLabel } from "@/components/dashboard/agent-label";
import { DetailMeta, DetailStats, DetailTitle } from "@/components/detail/layout";
import { EmptyState } from "@/components/empty-state";
import { Markdown } from "@/components/markdown";
import { ModelBadge } from "@/components/meta/model-badge";
import { Stat } from "@/components/meta/stat";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, unwrap, useApi } from "@/lib/api";
import type { SessionMessage } from "@/lib/api-schemas";
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
	const { user } = useUser();

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
		initialPageParam: direction === "desc" ? Math.max(0, totalForPaging - PAGE_SIZE) : 0,
		queryFn: async ({ pageParam }) => {
			const offset = pageParam as number;
			// In desc mode the last page may be smaller than PAGE_SIZE
			// (the "remaining" slice at the start of the array). The
			// server clamps `limit` against the array length anyway,
			// but we explicitly compute the right `limit` to avoid an
			// off-by-one if the cache key changes mid-flight.
			const limit =
				direction === "desc" && offset === 0 ? Math.min(PAGE_SIZE, totalForPaging) : PAGE_SIZE;
			return unwrap(
				await api.GET("/api/sessions/{session_id}/messages", {
					params: {
						path: { session_id: id },
						query: { offset, limit },
					},
				}),
			);
		},
		getNextPageParam: (last) => {
			if (direction === "asc") {
				const nextOffset = last.offset + last.items.length;
				return nextOffset >= last.total ? undefined : nextOffset;
			}
			// desc: previous page covered [last.offset, last.offset +
			// items.length). Next-older page ends at last.offset.
			if (last.offset === 0) return undefined;
			return Math.max(0, last.offset - PAGE_SIZE);
		},
		enabled: !!session?.has_content,
		retry: (failureCount, err) => {
			const status = err instanceof ApiError ? err.status : 0;
			if (status >= 400 && status < 500) return false;
			return failureCount < 2;
		},
	});

	// Flatten pages → ordered message list. In `asc` each page is
	// in canonical order and concatenating preserves it. In `desc`
	// the FIRST page is the newest 100 (in canonical order within),
	// so we reverse each page individually then concat — yielding
	// `[newest, ..., oldest-of-page-1, newest-of-page-2, ..., 0]`.
	const messages = useMemo(() => {
		if (!pagesData) return null;
		if (direction === "asc") return pagesData.pages.flatMap((p) => p.items);
		return pagesData.pages.flatMap((p) => [...p.items].reverse());
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
			<div className="space-y-2">
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

			{/* Divider */}
			<Separator />

			{/* Message-list toolbar — direction toggle. Sits between
			    the meta block and the message stream, so it's
			    discoverable but unobtrusive. Hidden when there are no
			    messages or content hasn't uploaded yet. */}
			{session.has_content && (messages?.length ?? 0) > 0 ? (
				<div className="flex items-center justify-between text-xs text-muted-foreground">
					<span>
						{direction === "desc" ? "Newest first" : "Oldest first"} · {loadedCount}/{totalMessages}
					</span>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="h-7 gap-1.5 text-xs"
						onClick={() => persistDirection(direction === "desc" ? "asc" : "desc")}
						aria-label={
							direction === "desc" ? "Show oldest messages first" : "Show newest messages first"
						}
					>
						{direction === "desc" ? (
							<>
								<ArrowUpNarrowWide className="size-3.5" />
								Show oldest first
							</>
						) : (
							<>
								<ArrowDownNarrowWide className="size-3.5" />
								Show newest first
							</>
						)}
					</Button>
				</div>
			) : null}

			{/* Messages */}
			{session.has_content ? (
				isContentLoading ? (
					<MessagesSkeleton />
				) : isContentError ? (
					<ContentFetchError />
				) : messages?.length ? (
					<div className="space-y-6">
						{(() => {
							// Insert date dividers when consecutive messages
							// cross day boundaries. Slack / Discord / iMessage
							// convention — long sessions span multiple days
							// and the per-message HH:MM stamp alone hides
							// "is this today's response or yesterday's?".
							const out: React.ReactNode[] = [];
							let prevDayKey: string | null = null;
							for (let i = 0; i < messages.length; i++) {
								const msg = messages[i];
								const key = dayKey(msg.timestamp);
								if (key && key !== prevDayKey) {
									out.push(<DateDivider key={`d-${key}`} timestamp={msg.timestamp ?? ""} />);
									prevDayKey = key;
								}
								out.push(
									<MessageBlock
										key={i}
										message={msg}
										userAvatar={user?.imageUrl}
										userName={user?.fullName || "You"}
										agentType={session.agent_type}
									/>,
								);
							}
							return out;
						})()}
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
				<EmptyState description="Conversation not uploaded yet. Refresh in a moment." />
			)}

			{/* Floating "jump to bottom" — only meaningful in asc mode
			    where the newest message is at the bottom of a long
			    list. In desc mode the newest is already at the top,
			    so there's nothing to jump to. */}
			{direction === "asc" && messages && messages.length > 20 ? <JumpToBottomButton /> : null}
		</div>
	);
}

function dayKey(timestamp: string | null | undefined): string | null {
	if (!timestamp) return null;
	const d = new Date(timestamp);
	if (Number.isNaN(d.getTime())) return null;
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function DateDivider({ timestamp }: { timestamp: string }) {
	const d = new Date(timestamp);
	const today = new Date();
	const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
	const dayDiff = Math.floor((startOfDay(today) - startOfDay(d)) / 86_400_000);
	let label: string;
	if (dayDiff === 0) label = "Today";
	else if (dayDiff === 1) label = "Yesterday";
	else
		label = d.toLocaleDateString(undefined, {
			weekday: "long",
			month: "short",
			day: "numeric",
			year: d.getFullYear() !== today.getFullYear() ? "numeric" : undefined,
		});
	return (
		<div className="my-4 flex items-center gap-3 text-xs uppercase tracking-wide text-muted-foreground">
			<div className="h-px flex-1 bg-border" />
			<span title={formatAbsoluteTooltip(timestamp)}>{label}</span>
			<div className="h-px flex-1 bg-border" />
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

function MessageBlock({
	message,
	userAvatar,
	userName,
	agentType,
}: {
	message: SessionMessage;
	userAvatar?: string;
	userName: string;
	agentType: string | null | undefined;
}) {
	const isUser = message.role === "user";
	const agentName = agentTypeLabel(agentType);

	return (
		<div className="flex gap-3">
			{/* Avatar column — user gets their Clerk avatar; assistant gets
			    the agent's brand logo so the conversation reads as
			    "you ↔ Claude/Codex/…". Both rendered at AgentIconSize "lg"
			    (32px) so the user and agent avatars line up vertically and
			    the column has a single consistent width. */}
			<div className="w-8 shrink-0 pt-0.5">
				{isUser ? (
					userAvatar ? (
						<Image src={userAvatar} alt="" width={32} height={32} className="rounded-full" />
					) : (
						<div className="flex size-8 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-medium">
							{userName[0]}
						</div>
					)
				) : (
					<AgentIcon agent={agentType} size="lg" shape="circle" />
				)}
			</div>

			{/* Content */}
			<div className="min-w-0 flex-1">
				{/* Author line */}
				<div className="mb-1 flex items-center gap-2">
					<span className="text-sm font-medium">{isUser ? userName : agentName}</span>
					{isUser ? null : <ModelBadge modelId={message.model} />}
					{message.timestamp ? (
						<span
							className="text-xs text-muted-foreground"
							title={formatAbsoluteTooltip(message.timestamp)}
						>
							{new Date(message.timestamp).toLocaleTimeString([], {
								hour: "2-digit",
								minute: "2-digit",
							})}
						</span>
					) : null}
				</div>

				{/* Message body */}
				<div className="text-sm">
					{isUser ? (
						<UserMessageBody content={message.content} />
					) : (
						<Markdown content={message.content} />
					)}
				</div>
			</div>
		</div>
	);
}

// Matches Claude Code's slash command envelope:
//   <command-message>name</command-message>
//   <command-name>/name</command-name>
//   <command-args>…</command-args>
const COMMAND_TAG_RE = /<command-(?:message|name|args)>[\s\S]*?<\/command-(?:message|name|args)>/g;

function parseSlashCommand(content: string): {
	name: string;
	args?: string;
	remaining: string;
} | null {
	const nameMatch = content.match(/<command-name>([\s\S]*?)<\/command-name>/);
	if (!nameMatch) return null;
	const argsMatch = content.match(/<command-args>([\s\S]*?)<\/command-args>/);
	const remaining = content.replace(COMMAND_TAG_RE, "").trim();
	return {
		name: nameMatch[1].trim(),
		args: argsMatch?.[1].trim() || undefined,
		remaining,
	};
}

// Claude Code's slash command expansion arrives as a user message whose body
// is the skill's SKILL.md content — typically starts with "Base directory for this skill:".
function isSkillExpansion(content: string): boolean {
	return /^Base directory for this skill:/i.test(content.trimStart());
}

function UserMessageBody({ content }: { content: string }) {
	const cmd = parseSlashCommand(content);
	if (cmd) {
		return (
			<div className="space-y-2">
				<SlashCommandPill name={cmd.name} args={cmd.args} />
				{cmd.remaining && <Markdown content={cmd.remaining} />}
			</div>
		);
	}
	if (isSkillExpansion(content)) {
		return <CollapsibleBlock label="Skill context" content={content} />;
	}
	return <Markdown content={content} />;
}

function SlashCommandPill({ name, args }: { name: string; args?: string }) {
	return (
		<div className="inline-flex max-w-full flex-wrap items-center gap-1.5 rounded-md border border-primary/20 bg-primary/5 px-2 py-1 font-mono text-xs">
			<Terminal className="size-3 shrink-0 text-primary" />
			<span className="font-medium text-primary">{name}</span>
			{args && <span className="break-all text-muted-foreground">{args}</span>}
		</div>
	);
}

function CollapsibleBlock({ label, content }: { label: string; content: string }) {
	const [open, setOpen] = useState(false);
	return (
		<div className="rounded-md border border-dashed border-border/70 bg-muted/20">
			<Button
				variant="ghost"
				size="sm"
				onClick={() => setOpen((v) => !v)}
				className="h-auto w-full justify-start rounded-md px-2.5 py-1.5 text-xs font-normal text-muted-foreground hover:text-foreground"
			>
				<ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
				<span>{label}</span>
				{!open && (
					<span className="text-xs text-muted-foreground">
						({content.length.toLocaleString()} chars)
					</span>
				)}
			</Button>
			{open && (
				<div className="border-t border-border/50 px-3 py-2">
					<Markdown content={content} />
				</div>
			)}
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
			description="Failed to load session content. Check your connection and try refreshing."
		/>
	);
}
