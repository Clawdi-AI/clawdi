"use client";

import { MessageSquare, Zap } from "lucide-react";
import { AgentLabel } from "@/components/dashboard/agent-label";
import { Stat } from "@/components/meta/stat";
import { Skeleton } from "@/components/ui/skeleton";
import type { SessionListItem } from "@/lib/api-schemas";
import { sessionDetailHref } from "@/lib/project-resource-model";
import Link from "@/lib/router-link";
import {
	cn,
	formatAbsoluteTooltip,
	formatNumber,
	formatSessionSummary,
	recencyBucketFor,
	relativeTime,
} from "@/lib/utils";

/* Human feed for sessions (journey J1): day-grouped cards with the summary
 * as the headline. The data table remains available behind the view toggle
 * for power users. */

export function SessionFeed({
	sessions,
	isLoading,
	emptyMessage,
	grouped = true,
	groupBy = "last_activity_at",
	showAgent = true,
	quietAutomated = true,
	sessionHref = (session) => sessionDetailHref(session.id),
}: {
	sessions: SessionListItem[];
	isLoading: boolean;
	emptyMessage: string;
	/** Group under Today / Yesterday / … headers (only meaningful for date sorts). */
	grouped?: boolean;
	groupBy?: "last_activity_at" | "started_at";
	/** Hide the per-card agent identity on pages that ARE the agent. */
	showAgent?: boolean;
	/** Mute Cron/heartbeat rows. Turn OFF while searching — muted search
	 * results read as disabled (journey simulation finding J1). */
	quietAutomated?: boolean;
	/** Build the detail link for the current navigation scope. */
	sessionHref?: (session: SessionListItem) => string;
}) {
	if (isLoading) {
		return (
			<div className="space-y-3">
				{Array.from({ length: 5 }).map((_, index) => (
					<div key={index} className="rounded-lg border bg-card p-4">
						<Skeleton className="h-4 w-4/5" />
						<Skeleton className="mt-3 h-3 w-1/2" />
					</div>
				))}
			</div>
		);
	}

	if (sessions.length === 0) {
		return (
			<div className="rounded-lg border border-dashed px-4 py-16 text-center text-sm text-muted-foreground">
				{emptyMessage}
			</div>
		);
	}

	if (!grouped) {
		return (
			<div className="space-y-3">
				{sessions.map((session) => (
					<SessionFeedCard
						key={session.id}
						session={session}
						showAgent={showAgent}
						quietAutomated={quietAutomated}
						href={sessionHref(session)}
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
		<div className="space-y-5">
			{groups.map((group) => (
				<section key={group.key} className="space-y-2">
					<h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
						{group.label}
					</h3>
					<div className="space-y-2">
						{group.items.map((session) => (
							<SessionFeedCard
								key={session.id}
								session={session}
								showAgent={showAgent}
								quietAutomated={quietAutomated}
								href={sessionHref(session)}
							/>
						))}
					</div>
				</section>
			))}
		</div>
	);
}

function SessionFeedCard({
	session,
	showAgent = true,
	quietAutomated = true,
	href,
}: {
	session: SessionListItem;
	showAgent?: boolean;
	quietAutomated?: boolean;
	href: string;
}) {
	const title = formatSessionSummary(session.summary) || session.local_session_id.slice(0, 8);
	const projectFolder = session.project_path?.split("/").pop();
	const totalTokens = session.input_tokens + session.output_tokens;
	// Cron jobs and bracketed heartbeats are routine noise — keep them in the
	// timeline but visually quieter than human work (taste audit round 2).
	const isAutomated = quietAutomated && /^(Cron:|\[)/.test(title);
	return (
		<article
			className={cn(
				"group relative z-0 rounded-lg border bg-card transition-all duration-150 hover:-translate-y-px hover:border-foreground/20",
				isAutomated ? "border-transparent bg-muted/40 p-3" : "p-4",
			)}
		>
			<Link
				href={href}
				className="absolute inset-0 z-10 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			>
				<span className="sr-only">Open session {session.local_session_id}</span>
			</Link>
			<div className="flex items-start justify-between gap-3">
				<h4
					className={cn(
						"min-w-0 truncate text-sm",
						isAutomated ? "font-normal text-muted-foreground" : "font-medium",
					)}
				>
					{title}
				</h4>
				<span
					className="shrink-0 text-xs text-muted-foreground"
					title={formatAbsoluteTooltip(session.last_activity_at)}
				>
					{relativeTime(session.last_activity_at)}
				</span>
			</div>
			<div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
				{showAgent ? (
					<AgentLabel machineName={session.machine_name} type={session.agent_type} size="sm" />
				) : null}
				{projectFolder ? (
					<span className="truncate font-mono" title={session.project_path ?? undefined}>
						{projectFolder}
					</span>
				) : null}
				<Stat icon={MessageSquare} label={`${session.message_count}`} />
				<Stat icon={Zap} label={formatNumber(totalTokens)} />
			</div>
		</article>
	);
}
