"use client";

import { sessionFeedClasses } from "@clawdi/shared/ui";

import {
	agentIdentity,
	formatAbsoluteTooltip,
	formatNumber,
	groupSessionsByRecency,
	profileLabel,
	relativeTime,
	sessionAgentIdentityInput,
	sessionCardModel,
} from "@clawdi/shared/view";
import { Link, type LinkProps } from "@tanstack/react-router";
import { MessageSquare } from "lucide-react";
import { AgentIcon } from "@/components/dashboard/agent-icon";
import { EmptyState, type EmptyStateVariant } from "@/components/empty-state";
import { ENTITY_CARD_BASE } from "@/components/entity-card";
import { SectionLabel } from "@/components/section-label";
import { SessionSearchMatchExcerpt } from "@/components/sessions/search-match-excerpt";
import { Skeleton } from "@/components/ui/skeleton";
import type { SessionListItem } from "@/lib/api-schemas";
import { sessionDetailLink } from "@/lib/session-search-anchor";
import { cn } from "@/lib/utils";

type SessionLinkOptions = Pick<LinkProps, "to" | "params" | "search" | "hash">;

type SessionMetadataItem = {
	key: string;
	value: string;
	title?: string;
	className?: string;
};

// Title, metadata, padding and borders occupy 80px on narrow layouts; wide
// layouts use one metadata line and the established 66px minimum.
const SESSION_ROW_HEIGHT_CLASS = sessionFeedClasses.rowHeight;
const SESSION_CARD_CLASS = cn(SESSION_ROW_HEIGHT_CLASS, sessionFeedClasses.card);
const OVERVIEW_SESSION_LIST_CLASS = cn(SESSION_ROW_HEIGHT_CLASS, sessionFeedClasses.overviewList);

function SessionCardSkeleton({ testId }: { testId?: string }) {
	return (
		<div
			data-testid={testId}
			aria-hidden="true"
			className={cn(ENTITY_CARD_BASE, SESSION_CARD_CLASS)}
		>
			<Skeleton className={sessionFeedClasses.avatarSkeleton} />
			<div className={sessionFeedClasses.skeletonBody}>
				<div className={sessionFeedClasses.skeletonTitle}>
					<Skeleton className={sessionFeedClasses.titleSkeleton} />
				</div>
				<div className={sessionFeedClasses.skeletonMeta}>
					<Skeleton className={sessionFeedClasses.metaSkeleton} />
					<Skeleton className={sessionFeedClasses.secondaryMetaSkeleton} />
				</div>
			</div>
		</div>
	);
}

export function OverviewSessionListSkeleton() {
	return (
		<div
			data-testid="overview-session-grid"
			className={OVERVIEW_SESSION_LIST_CLASS}
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
	return (
		<div data-testid="overview-session-grid" className={OVERVIEW_SESSION_LIST_CLASS}>
			{visibleSessions.map((session) => (
				<SessionCard
					key={session.id}
					session={session}
					showAgent={false}
					quietAutomated={true}
					link={sessionLink(session)}
				/>
			))}
			{Array.from({ length: 3 - visibleSessions.length }).map((_, index) => (
				<div
					key={index}
					data-testid="overview-session-placeholder"
					aria-hidden={visibleSessions.length > 0 || index > 0 ? true : undefined}
					className={cn(ENTITY_CARD_BASE, SESSION_CARD_CLASS, sessionFeedClasses.emptyRow)}
				>
					{visibleSessions.length === 0 && index === 0 ? emptyMessage : null}
				</div>
			))}
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
	sessionLink = sessionDetailLink,
	searchQuery = "",
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
	searchQuery?: string;
}) {
	if (isLoading) {
		return (
			<div className={sessionFeedClasses.list}>
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
			<div className={sessionFeedClasses.list}>
				{sessions.map((session) => (
					<SessionCard
						key={session.id}
						session={session}
						showAgent={showAgent}
						quietAutomated={quietAutomated}
						link={sessionLink(session)}
						searchQuery={searchQuery}
					/>
				))}
			</div>
		);
	}

	const groups = groupSessionsByRecency(sessions, groupBy);

	return (
		<div className={sessionFeedClasses.groups}>
			{groups.map((group) => (
				<section key={group.key} className={sessionFeedClasses.list}>
					<SectionLabel>{group.label}</SectionLabel>
					<div className={sessionFeedClasses.list}>
						{group.items.map((session) => (
							<SessionCard
								key={session.id}
								session={session}
								showAgent={showAgent}
								quietAutomated={quietAutomated}
								link={sessionLink(session)}
								searchQuery={searchQuery}
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
	searchQuery = "",
}: {
	session: SessionListItem;
	showAgent?: boolean;
	quietAutomated?: boolean;
	link: SessionLinkOptions;
	searchQuery?: string;
}) {
	const { title, projectFolder, totalTokens, isAutomated } = sessionCardModel(
		session,
		quietAutomated,
	);
	const agent = agentIdentity(sessionAgentIdentityInput(session)).primaryLabel;
	const profile = profileLabel(session);
	const metadata: SessionMetadataItem[] = [
		// Default-profile sessions carry no profile label.
		showAgent
			? { key: "agent", value: profile ? `${agent} · ${profile}` : agent }
			: profile
				? { key: "profile", value: profile, title: `Profile: ${profile}` }
				: null,
		projectFolder
			? {
					key: "project",
					value: projectFolder,
					title: session.project_path ?? undefined,
					className: String(sessionFeedClasses.project),
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
		<article data-testid="session-card" className={sessionFeedClasses.root}>
			<Link
				{...link}
				aria-label={`Open session ${title}`}
				className={cn(
					ENTITY_CARD_BASE,
					SESSION_CARD_CLASS,
					sessionFeedClasses.link,
					isAutomated && sessionFeedClasses.automated,
				)}
			>
				<span data-testid="session-card-avatar" className={sessionFeedClasses.avatar}>
					<AgentIcon agent={session.agent_type} size="lg" />
				</span>
				<span data-testid="session-card-text" className={sessionFeedClasses.body}>
					<span data-testid="session-card-title" className={sessionFeedClasses.title} title={title}>
						{title}
					</span>
					{session.search_match ? (
						<SessionSearchMatchExcerpt
							match={session.search_match}
							query={searchQuery}
							className={sessionFeedClasses.searchExcerpt}
						/>
					) : null}
					<span data-testid="session-card-meta" className={sessionFeedClasses.meta}>
						{metadata.map((item, index) => (
							<span key={item.key} className={sessionFeedClasses.metaItem}>
								{index > 0 ? (
									<span className={sessionFeedClasses.metaSeparator} aria-hidden="true">
										·
									</span>
								) : null}
								<span
									className={cn(sessionFeedClasses.metaValue, item.className)}
									title={item.title}
								>
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
