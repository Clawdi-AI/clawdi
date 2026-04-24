"use client";

import { useAuth, useUser } from "@clerk/nextjs";
import { useQuery } from "@tanstack/react-query";
import {
	ChevronRight,
	Clock,
	Hash,
	type LucideIcon,
	MessageSquare,
	Terminal,
	Zap,
} from "lucide-react";
import Image from "next/image";
import { useParams } from "next/navigation";
import { useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { Markdown } from "@/components/markdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, apiFetch } from "@/lib/api";
import type { SessionDetail, SessionMessage } from "@/lib/api-schemas";
import { cn, formatSessionSummary, relativeTime } from "@/lib/utils";

function formatDuration(seconds: number | null): string {
	if (!seconds) return "-";
	if (seconds < 60) return `${seconds}s`;
	const mins = Math.floor(seconds / 60);
	if (mins < 60) return `${mins}m`;
	return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
}

export default function SessionDetailPage() {
	const { id } = useParams<{ id: string }>();
	const { getToken } = useAuth();
	const { user } = useUser();

	const { data: session, isLoading: isSessionLoading } = useQuery({
		queryKey: ["session", id],
		queryFn: async () => {
			const token = await getToken();
			if (!token) throw new Error("Not authenticated");
			return apiFetch<SessionDetail>(`/api/sessions/${id}`, token);
		},
		// Don't retry 4xx (malformed UUID, not-found, unauthorized) — they won't
		// recover on retry and the default 3× retry makes the page hang in
		// "Loading..." for seconds before the user learns the URL is bogus.
		retry: (failureCount, err) => {
			const status = err instanceof ApiError ? err.status : 0;
			if (status >= 400 && status < 500) return false;
			return failureCount < 2;
		},
	});

	const {
		data: messages,
		isLoading: isContentLoading,
		isError: isContentError,
	} = useQuery({
		queryKey: ["session-content", id],
		queryFn: async () => {
			const token = await getToken();
			if (!token) throw new Error("Not authenticated");
			return apiFetch<SessionMessage[]>(`/api/sessions/${id}/content`, token);
		},
		enabled: !!session?.has_content,
		retry: (failureCount, err) => {
			const status = err instanceof ApiError ? err.status : 0;
			if (status >= 400 && status < 500) return false;
			return failureCount < 2;
		},
	});

	if (isSessionLoading) {
		return (
			<div className="space-y-5 px-4 lg:px-6">
				<DetailSkeleton />
			</div>
		);
	}

	if (!session) {
		return (
			<div className="space-y-5 px-4 lg:px-6">
				<p className="text-muted-foreground">Session not found.</p>
			</div>
		);
	}

	const totalTokens = (session.input_tokens ?? 0) + (session.output_tokens ?? 0);

	return (
		<div className="space-y-5 px-4 lg:px-6">
			{/* Header */}
			<div>
				<h1 className="text-lg font-semibold tracking-tight">
					{formatSessionSummary(session.summary) || session.local_session_id.slice(0, 12)}
				</h1>
				<p className="text-xs text-muted-foreground mt-1">
					{session.project_path || "No project path"} · {relativeTime(session.started_at)}
				</p>
			</div>

			{/* Stats bar */}
			<div className="flex flex-wrap items-center gap-3">
				{session.agent_type && (
					<Badge variant="secondary">
						{session.agent_type === "claude_code"
							? "Claude Code"
							: session.agent_type === "hermes"
								? "Hermes"
								: session.agent_type}
					</Badge>
				)}
				{session.model && (
					<Badge variant="outline" className="border-primary/30 text-primary">
						{session.model.replace("claude-", "")}
					</Badge>
				)}
				<Stat icon={MessageSquare} label={`${session.message_count} messages`} />
				<Stat icon={Zap} label={`${formatTokens(totalTokens)} tokens`} />
				{session.duration_seconds && (
					<Stat icon={Clock} label={formatDuration(session.duration_seconds)} />
				)}
				<Stat icon={Hash} label={session.local_session_id.slice(0, 8)} />
			</div>

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
								agentName={
									session.agent_type === "hermes"
										? "Hermes"
										: session.agent_type === "claude_code"
											? "Claude"
											: "AI"
								}
							/>
						))}
					</div>
				) : (
					<EmptyContent />
				)
			) : (
				<EmptyState
					description={
						<>
							Content not synced yet. Run{" "}
							<code className="bg-muted px-1.5 py-0.5 rounded text-xs">
								clawdi sync up --modules sessions
							</code>{" "}
							to upload session content.
						</>
					}
				/>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function Stat({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
	return (
		<span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
			<Icon className="size-3.5" />
			{label}
		</span>
	);
}

function MessageBlock({
	message,
	userAvatar,
	userName,
	agentName,
}: {
	message: SessionMessage;
	userAvatar?: string;
	userName: string;
	agentName: string;
}) {
	const isUser = message.role === "user";

	return (
		<div className="flex gap-3">
			{/* Avatar column — user gets their avatar, assistant gets nothing (spacer) */}
			<div className="w-7 shrink-0 pt-0.5">
				{isUser && userAvatar ? (
					<Image src={userAvatar} alt="" width={28} height={28} className="rounded-full" />
				) : isUser ? (
					<div className="size-7 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-medium">
						{userName[0]}
					</div>
				) : null}
			</div>

			{/* Content */}
			<div className="min-w-0 flex-1">
				{/* Author line */}
				<div className="flex items-center gap-2 mb-1">
					<span className="text-sm font-medium">{isUser ? userName : agentName}</span>
					{!isUser && message.model && (
						<Badge variant="secondary">{message.model.replace("claude-", "")}</Badge>
					)}
					{message.timestamp && (
						<span className="text-xs text-muted-foreground">
							{new Date(message.timestamp).toLocaleTimeString([], {
								hour: "2-digit",
								minute: "2-digit",
							})}
						</span>
					)}
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
	return <EmptyState description="No messages in this session." />;
}

function ContentFetchError() {
	return (
		<EmptyState description="Failed to load session content. Check your connection and try refreshing." />
	);
}
