"use client";

import { Link, type LinkProps } from "@tanstack/react-router";
import { MessageSquare } from "lucide-react";
import { AgentIcon } from "@/components/dashboard/agent-icon";
import { agentIdentity } from "@/components/dashboard/agent-label";
import { EmptyState, type EmptyStateVariant } from "@/components/empty-state";
import { ENTITY_CARD_BASE } from "@/components/entity-card";
import { SectionLabel } from "@/components/section-label";
import { sessionAgentIdentityInput } from "@/components/sessions/session-agent-label";
import { Skeleton } from "@/components/ui/skeleton";
import type { SessionListItem } from "@/lib/api-schemas";
import {
	cn,
	formatAbsoluteTooltip,
	formatNumber,
	formatSessionSummary,
	recencyBucketFor,
	relativeTime,
} from "@/lib/utils";

type SessionLinkOptions = Pick<LinkProps, "to" | "params" | "search" | "hash">;

type SessionMetadataItem = {
	key: string;
	value: string;
	title?: string;
	className?: string;
};

const SESSION_CARD_CLASS = "flex min-h-16.5 min-w-0 items-center gap-3 px-4 py-3 transition-colors";

function SessionCardSkeleton({ testId }: { testId?: string }) {
	return (
		<div
			data-testid={testId}
			aria-hidden="true"
			className={cn(ENTITY_CARD_BASE, SESSION_CARD_CLASS)}
		>
			<Skeleton className="size-8 shrink-0 rounded-md" />
			<div className="min-w-0 flex-1">
				<Skeleton className="h-4 w-4/5" />
				<Skeleton className="mt-1.5 h-3 w-1/2" />
			</div>
		</div>
	);
}

export function OverviewSessionListSkeleton() {
	return (
		<div
			data-testid="overview-session-grid"
			className="grid gap-2"
			aria-label="Loading recent sessions"
			role="status"
		>
			{Array.from({ length: 3 }).map((_, index) => (
				<SessionCardSkeleton key={index} testId="overview-session-skeleton-row" />
			))}
		</div>
	);
}

export function OverviewSessionList({
	sessions,
	isLoading,
	emptyMessage,
	sessionLink,
}: {
	sessions: SessionListItem[];
	isLoading: boolean;
	emptyMessage: string;
	sessionLink: (session: SessionListItem) => SessionLinkOptions;
}) {
	if (isLoading) {
		return <OverviewSessionListSkeleton />;
	}
	const visibleSessions = sessions.slice(0, 3);
	const placeholderCount = 3 - visibleSessions.length;
	return (
		<div data-testid="overview-session-grid" className="grid gap-2">
			{visibleSessions.map((session) => (
				<SessionCard
					key={session.id}
					session={session}
					showAgent={false}
					quietAutomated={true}
					link={sessionLink(session)}
				/>
			))}
			{Array.from({ length: placeholderCount }).map((_, index) => (
				<div
					key={`placeholder-${index}`}
					data-testid="overview-session-placeholder"
					aria-hidden="true"
					className={cn(
						ENTITY_CARD_BASE,
						SESSION_CARD_CLASS,
						"pointer-events-none border-border/60 bg-muted/10 text-xs text-muted-foreground select-none",
					)}
				>
					{visibleSessions.length === 0 && index === 0 ? emptyMessage : null}
				</div>
			))}
			{visibleSessions.length === 0 ? (
				<p className="sr-only" role="status">
					{emptyMessage}
				</p>
			) : null}
		</div>
	);
}

/* Human feed for sessions (journey J1): day-grouped cards with the summary
 * as the headline. The data table remains available behind the view toggle
 * for power users. */

export function SessionFeed({
	sessions,
	isLoading,
	emptyMessage,
	emptyVariant = "page",
	grouped = true,
	groupBy = "last_activity_at",
	showAgent = true,
	quietAutomated = true,
	sessionLink = (session) => ({ to: "/sessions/$id", params: { id: session.id } }),
}: {
	sessions: SessionListItem[];
	isLoading: boolean;
	emptyMessage: string;
	emptyVariant?: EmptyStateVariant;
	/** Group under Today / Yesterday / … headers (only meaningful for date sorts). */
	grouped?: boolean;
	groupBy?: "last_activity_at" | "started_at";
	/** Hide the per-card agent identity on pages that ARE the agent. */
	showAgent?: boolean;
	/** Mute Cron/heartbeat rows. Turn OFF while searching — muted search
	 * results read as disabled (journey simulation finding J1). */
	quietAutomated?: boolean;
	/** Build the detail link for the current navigation scope. */
	sessionLink?: (session: SessionListItem) => SessionLinkOptions;
}) {
	if (isLoading) {
		return (
			<div className="flex flex-col gap-2">
				{Array.from({ length: 5 }).map((_, index) => (
					<SessionCardSkeleton key={index} />
				))}
			</div>
		);
	}

	if (sessions.length === 0) {
		return <EmptyState variant={emptyVariant} icon={MessageSquare} description={emptyMessage} />;
	}

	if (!grouped) {
		return (
			<div className="flex flex-col gap-2">
				{sessions.map((session) => (
					<SessionCard
						key={session.id}
						session={session}
						showAgent={showAgent}
						quietAutomated={quietAutomated}
						link={sessionLink(session)}
					/>
				))}
			</div>
		);
	}

	const groups: Array<{ key: string; label: string; items: SessionListItem[] }> = [];
	for (const session of sessions) {
		const bucket = recencyBucketFor(
			groupBy === "started_at" ? session.started_at : session.last_activity_at,
		);
		const last = groups[groups.length - 1];
		if (last && last.key === bucket.key) last.items.push(session);
		else groups.push({ key: bucket.key, label: bucket.label, items: [session] });
	}

	return (
		<div className="flex flex-col gap-5">
			{groups.map((group) => (
				<section key={group.key} className="flex flex-col gap-2">
					<SectionLabel>{group.label}</SectionLabel>
					<div className="flex flex-col gap-2">
						{group.items.map((session) => (
							<SessionCard
								key={session.id}
								session={session}
								showAgent={showAgent}
								quietAutomated={quietAutomated}
								link={sessionLink(session)}
							/>
						))}
					</div>
				</section>
			))}
		</div>
	);
}

export function SessionCard({
	session,
	showAgent = true,
	quietAutomated = true,
	link,
}: {
	session: SessionListItem;
	showAgent?: boolean;
	quietAutomated?: boolean;
	link: SessionLinkOptions;
}) {
	const title = formatSessionSummary(session.summary) || session.local_session_id.slice(0, 8);
	const projectFolder = session.project_path?.split("/").pop();
	const totalTokens = session.input_tokens + session.output_tokens;
	const agent = agentIdentity(sessionAgentIdentityInput(session)).primaryLabel;
	// Cron jobs and bracketed heartbeats are routine noise — keep them in the
	// timeline but visually quieter than human work (taste audit round 2).
	const isAutomated = quietAutomated && /^(Cron:|\[)/.test(title);
	const metadata: SessionMetadataItem[] = [
		showAgent ? { key: "agent", value: agent } : null,
		projectFolder
			? {
					key: "project",
					value: projectFolder,
					title: session.project_path ?? undefined,
					className: "font-mono",
				}
			: null,
		{
			key: "messages",
			value: `${session.message_count} ${session.message_count === 1 ? "message" : "messages"}`,
		},
		{ key: "tokens", value: `${formatNumber(totalTokens)} tokens` },
		{
			key: "time",
			value: relativeTime(session.last_activity_at),
			title: formatAbsoluteTooltip(session.last_activity_at),
		},
	].filter((item): item is SessionMetadataItem => item !== null);
	return (
		<article data-testid="session-card" className="min-w-0">
			<Link
				{...link}
				aria-label={`Open session ${title}`}
				className={cn(
					ENTITY_CARD_BASE,
					SESSION_CARD_CLASS,
					"group hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
					isAutomated && "bg-muted/30",
				)}
			>
				<span data-testid="session-card-avatar" className="flex shrink-0">
					<AgentIcon agent={session.agent_type} size="lg" />
				</span>
				<span data-testid="session-card-text" className="w-0 min-w-0 flex-1">
					<span
						data-testid="session-card-title"
						className="block truncate text-sm leading-5 font-semibold"
						title={title}
					>
						{title}
					</span>
					<span
						data-testid="session-card-meta"
						className="mt-0.5 flex min-w-0 flex-wrap items-center gap-y-0 text-xs leading-4 text-muted-foreground"
					>
						{metadata.map((item, index) => (
							<span key={item.key} className="inline-flex min-w-0 max-w-full items-center">
								{index > 0 ? (
									<span className="mx-1.5 shrink-0 text-muted-foreground/40" aria-hidden="true">
										·
									</span>
								) : null}
								<span className={cn("min-w-0 truncate", item.className)} title={item.title}>
									{item.value}
								</span>
							</span>
						))}
					</span>
				</span>
			</Link>
		</article>
	);
}
