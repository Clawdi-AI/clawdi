"use client";

import { useAuth, useUser } from "@clerk/nextjs";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Clock, Hash, MessageSquare, Zap } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Markdown } from "@/components/markdown";
import { Skeleton } from "@/components/ui/skeleton";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";

interface SessionMessage {
  role: "user" | "assistant";
  content: string;
  model?: string;
  timestamp?: string;
}

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

function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
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
      return apiFetch<any>(`/api/sessions/${id}`, token);
    },
  });

  const { data: messages, isLoading: isContentLoading } = useQuery({
    queryKey: ["session-content", id],
    queryFn: async () => {
      const token = await getToken();
      if (!token) throw new Error("Not authenticated");
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"}/api/sessions/${id}/content`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) return null;
      return res.json() as Promise<SessionMessage[]>;
    },
    enabled: !!session?.has_content,
  });

  if (isSessionLoading) {
    return (
      <div className="mx-auto max-w-5xl space-y-5 px-4 py-4 md:px-6 md:py-6">
        <BackLink />
        <DetailSkeleton />
      </div>
    );
  }

  if (!session) {
    return (
      <div className="mx-auto max-w-5xl space-y-5 px-4 py-4 md:px-6 md:py-6">
        <BackLink />
        <p className="text-muted-foreground">Session not found.</p>
      </div>
    );
  }

  const totalTokens = (session.input_tokens ?? 0) + (session.output_tokens ?? 0);

  return (
    <div className="mx-auto max-w-5xl space-y-5 px-4 py-4 md:px-6 md:py-6">
      <BackLink />

      {/* Header */}
      <div>
        <h1 className="text-lg font-semibold tracking-tight">
          {session.summary || session.local_session_id.slice(0, 12)}
        </h1>
        <p className="text-xs text-muted-foreground mt-1">
          {session.project_path || "No project path"} · {relativeTime(session.started_at)}
        </p>
      </div>

      {/* Stats bar */}
      <div className="flex flex-wrap items-center gap-3">
        {session.model && (
          <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
            {session.model.replace("claude-", "")}
          </span>
        )}
        <Stat icon={MessageSquare} label={`${session.message_count} messages`} />
        <Stat icon={Zap} label={`${formatTokens(totalTokens)} tokens`} />
        {session.duration_seconds && (
          <Stat icon={Clock} label={formatDuration(session.duration_seconds)} />
        )}
        <Stat icon={Hash} label={session.local_session_id.slice(0, 8)} />
      </div>

      {/* Divider */}
      <div className="h-px bg-border" />

      {/* Messages */}
      {session.has_content ? (
        isContentLoading ? (
          <MessagesSkeleton />
        ) : messages?.length ? (
          <div className="space-y-6">
            {messages.map((msg, i) => (
              <MessageBlock
                key={i}
                message={msg}
                userAvatar={user?.imageUrl}
                userName={user?.fullName || "You"}
              />
            ))}
          </div>
        ) : (
          <EmptyContent />
        )
      ) : (
        <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          Content not synced yet. Run{" "}
          <code className="bg-muted px-1.5 py-0.5 rounded text-xs">
            clawdi sync up --modules sessions
          </code>{" "}
          to upload session content.
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function BackLink() {
  return (
    <Link
      href="/sessions"
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
    >
      <ArrowLeft className="size-4" />
      Sessions
    </Link>
  );
}

function Stat({ icon: Icon, label }: { icon: any; label: string }) {
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
}: {
  message: SessionMessage;
  userAvatar?: string;
  userName: string;
}) {
  const isUser = message.role === "user";

  return (
    <div className="flex gap-3">
      {/* Avatar column — user gets their avatar, assistant gets nothing (spacer) */}
      <div className="w-7 shrink-0 pt-0.5">
        {isUser && userAvatar ? (
          <Image
            src={userAvatar}
            alt=""
            width={28}
            height={28}
            className="rounded-full"
          />
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
          <span className="text-sm font-medium">
            {isUser ? userName : "Claude"}
          </span>
          {!isUser && message.model && (
            <span className="text-[10px] rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
              {message.model.replace("claude-", "")}
            </span>
          )}
          {message.timestamp && (
            <span className="text-[10px] text-muted-foreground">
              {new Date(message.timestamp).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          )}
        </div>

        {/* Message body */}
        {isUser ? (
          <div className="text-sm whitespace-pre-wrap">{message.content}</div>
        ) : (
          <div className="text-sm">
            <Markdown content={message.content} />
          </div>
        )}
      </div>
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
      <div className="h-px bg-border" />
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
  return (
    <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
      No messages in this session.
    </div>
  );
}
