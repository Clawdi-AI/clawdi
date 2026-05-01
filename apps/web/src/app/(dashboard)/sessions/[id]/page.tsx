"use client";

import { useUser } from "@clerk/nextjs";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ChevronRight, Clock, Hash, MessageSquare, Terminal, Zap } from "lucide-react";
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
import { cn, formatNumber, formatSessionSummary, relativeTime } from "@/lib/utils";

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

	// Paginated message fetch via the new `/messages` endpoint.
	// Long sessions (5k+ messages, 10+ MB JSON) used to ship the
	// whole blob in one shot and Markdown-render every turn,
	// which froze the page for seconds. Now we load 100 at a time
	// and the IntersectionObserver in `LoadMoreSentinel` requests
	// the next page when the user scrolls near the bottom.
	const PAGE_SIZE = 100;
	const {
		data: pagesData,
		isLoading: isContentLoading,
		isError: isContentError,
		fetchNextPage,
		hasNextPage,
		isFetchingNextPage,
	} = useInfiniteQuery({
		queryKey: ["session-messages", id],
		// Each page's `pageParam` is its `offset`; first page = 0.
		initialPageParam: 0,
		queryFn: async ({ pageParam }) =>
			unwrap(
				await api.GET("/api/sessions/{session_id}/messages", {
					params: {
						path: { session_id: id },
						query: { offset: pageParam, limit: PAGE_SIZE },
					},
				}),
			),
		getNextPageParam: (last) => {
			const nextOffset = last.offset + last.items.length;
			return nextOffset >= last.total ? undefined : nextOffset;
		},
		enabled: !!session?.has_content,
		retry: (failureCount, err) => {
			const status = err instanceof ApiError ? err.status : 0;
			if (status >= 400 && status < 500) return false;
			return failureCount < 2;
		},
	});

	// Flatten pages → ordered message list. The backend slices the
	// underlying JSON array, so concatenating pages preserves the
	// canonical order regardless of how many fetches it took.
	const messages = useMemo(() => pagesData?.pages.flatMap((p) => p.items) ?? null, [pagesData]);
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
					<span>{relativeTime(session.started_at)}</span>
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

			{/* Messages */}
			{session.has_content ? (
				isContentLoading ? (
					<MessagesSkeleton />
				) : isContentError ? (
					<ContentFetchError />
				) : messages?.length ? (
					<div className="space-y-6">
						{messages.map((msg, i) => (
							<MessageBlock
								key={i}
								message={msg}
								userAvatar={user?.imageUrl}
								userName={user?.fullName || "You"}
								agentType={session.agent_type}
							/>
						))}
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
		</div>
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
						<span className="text-xs text-muted-foreground">
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
