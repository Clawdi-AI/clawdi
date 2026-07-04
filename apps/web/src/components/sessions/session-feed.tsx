"use client";

import { Link, type LinkProps } from "@tanstack/react-router";
import { MessageSquare } from "lucide-react";
import { AgentIcon } from "@/components/dashboard/agent-icon";
import { agentIdentity } from "@/components/dashboard/agent-label";
import { EmptyState, type EmptyStateVariant } from "@/components/empty-state";
import { ENTITY_CARD_BASE, EntityHeader } from "@/components/entity-card";
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
					<div key={index} className={ENTITY_CARD_BASE}>
						<Skeleton className="h-4 w-4/5" />
						<Skeleton className="mt-3 h-3 w-1/2" />
					</div>
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
					<SessionFeedCard
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
							<SessionFeedCard
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

function SessionFeedCard({
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
	return (
		<article className="group relative z-0">
			<div
				className={cn(
					ENTITY_CARD_BASE,
					"transition-colors group-hover:bg-muted/50",
					isAutomated && "bg-muted/30",
				)}
			>
				<EntityHeader
					align="start"
					icon={<AgentIcon agent={session.agent_type} size="lg" />}
					title={title}
					meta={[
						showAgent ? agent : null,
						projectFolder ? (
							<span key="folder" className="font-mono" title={session.project_path ?? undefined}>
								{projectFolder}
							</span>
						) : null,
						`${session.message_count} ${session.message_count === 1 ? "message" : "messages"}`,
						`${formatNumber(totalTokens)} tokens`,
						<span key="time" title={formatAbsoluteTooltip(session.last_activity_at)}>
							{relativeTime(session.last_activity_at)}
						</span>,
					]}
				/>
			</div>
			<Link
				{...link}
				className="absolute inset-0 z-10 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
			>
				<span className="sr-only">Open session {session.local_session_id}</span>
			</Link>
		</article>
	);
}
