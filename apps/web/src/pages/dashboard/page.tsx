"use client";

import { dashboardPageClasses } from "@clawdi/shared/ui";
import {
	currentDaypart,
	dashboardGreeting,
	OVERVIEW_COPY,
	selfManagedAgentTiles,
} from "@clawdi/shared/view";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { lazy, type ReactNode, Suspense, useEffect, useMemo, useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { AddAgentDialog } from "@/components/dashboard/add-agent-dialog";
import { AgentsCard } from "@/components/dashboard/agents-card";
import { ContributionGraph } from "@/components/dashboard/contribution-graph";
import { OnboardingCard } from "@/components/dashboard/onboarding-card";
import { ResourcesCard } from "@/components/dashboard/resources-card";
import { ThisWeekCard } from "@/components/dashboard/this-week-card";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import { SessionFeed } from "@/components/sessions/session-feed";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useOpenApi } from "@/lib/api";
import { useCurrentUser } from "@/lib/auth-client";
import { useDesktopShell } from "@/lib/desktop-shell";
import { useProductAccess } from "@/lib/product-access";
import { shouldBlockQueryError } from "@/lib/query-state";
import { sessionListQueryOptions } from "@/lib/session-queries";
import { cn } from "@/lib/utils";

const RECENT_SESSIONS_LIMIT = 15;
const RECENT_SESSIONS_CACHE_PAGE_SIZE = 25;
const IS_HOSTED_BUILD = import.meta.env.VITE_CLAWDI_HOSTED === "true";

// Lazy imports gated on a build-time hosted flag. When the flag is false (OSS),
// the conditional collapses, the bundler eliminates the `import()` sites, and
// the entire `@/hosted/hosted-agents-section` chunk never ships in the OSS bundle.
//
// Two exports from the same module: `HostedAgentsSection` for the
// left-column agent panel, and `HostedSecondaryCTA` for the
// right-column "Connect another" CTA. Both call
// `useHostedAgentTiles` and share its TanStack Query cache, so
// rendering both still costs only one network request.
const HostedAgentsSection = IS_HOSTED_BUILD
	? lazy(() =>
			import("@/hosted/hosted-agents-section").then((m) => ({
				default: m.HostedAgentsSection,
			})),
		)
	: null;
const HostedSecondaryCTA = IS_HOSTED_BUILD
	? lazy(() =>
			import("@/hosted/hosted-agents-section").then((m) => ({
				default: m.HostedSecondaryCTA,
			})),
		)
	: null;
export default function DashboardPage() {
	const $api = useOpenApi();
	const hostedAccess = useProductAccess();

	const {
		data: stats,
		isLoading: statsLoading,
		error: statsError,
		refetch: refetchStats,
	} = $api.useQuery(
		"get",
		"/v1/dashboard/stats",
		{},
		{
			// Overview counts are cheap and reflect recent mutations across many
			// resources, so keep this query fresher than the global 30s default.
			staleTime: 0,
			refetchOnMount: "always",
		},
	);

	const {
		data: environments,
		isLoading: envsLoading,
		error: envsError,
		refetch: refetchEnvs,
	} = $api.useQuery(
		"get",
		"/v1/agents",
		{},
		{
			// Daemon-status badge classification is time-sensitive — a
			// daemon that paused while the tab was open would otherwise
			// stay green indefinitely. Match the agent detail page's
			// 10s cadence so the live indicator is actually live.
			refetchInterval: 10_000,
			refetchIntervalInBackground: false,
		},
	);

	// Manual sessions only: on a working fleet ~3/4 of sessions are
	// cron/heartbeat ticks, and "Recent sessions" buried the user's own
	// work under them. Automation is one click away via View all.
	const {
		data: sessionsPage,
		isLoading: sessionsLoading,
		error: sessionsError,
		refetch: refetchSessions,
	} = useQuery(
		sessionListQueryOptions($api, {
			page_size: RECENT_SESSIONS_CACHE_PAGE_SIZE,
			automated: false,
		}),
	);
	const sessions = sessionsPage?.items.slice(0, RECENT_SESSIONS_LIMIT);
	const contribution = stats?.contribution;
	const blockingStatsError = shouldBlockQueryError(statsError, stats) ? statsError : null;
	const blockingEnvsError = shouldBlockQueryError(envsError, environments) ? envsError : null;
	const blockingSessionsError = shouldBlockQueryError(sessionsError, sessionsPage)
		? sessionsError
		: null;

	const selfManagedTiles = useMemo(() => selfManagedAgentTiles(environments), [environments]);

	// Zero-state promotion: when the user has no agents yet, the
	// secondary CTA (connect one) lives in the right column. The
	// hosted code path may still render an AgentsCard if the user has
	// hosted deployments — that decision lives inside
	// `<HostedAgentsSection>` so this page doesn't need the hosted
	// counts at all.
	const selfManagedCount = selfManagedTiles.length;
	const hasAgents = !envsLoading && !blockingEnvsError && selfManagedCount > 0;
	const ossIsEmptyState = !envsLoading && !blockingEnvsError && selfManagedCount === 0;
	const hostedAccessLoading = Boolean(HostedAgentsSection && hostedAccess.isLoading);
	const cloudDeploymentManagementEnabled = Boolean(HostedAgentsSection);
	const legacyHostedAgentsEnabled = Boolean(
		HostedAgentsSection && hostedAccess.canUseLegacyHostedDashboard,
	);
	const hostedSectionEnabled = cloudDeploymentManagementEnabled || legacyHostedAgentsEnabled;

	return (
		<OverviewLayout
			greeting={<Greeting />}
			agents={
				hostedAccessLoading ? (
					<AgentsCard agents={selfManagedTiles} isLoading />
				) : hostedSectionEnabled && HostedAgentsSection ? (
					<Suspense fallback={<AgentsCard agents={selfManagedTiles} isLoading />}>
						<HostedAgentsSection
							envsLoading={envsLoading}
							selfManagedError={blockingEnvsError}
							onRetrySelfManaged={() => {
								void refetchEnvs();
							}}
							selfManagedCount={selfManagedCount}
							cloudEnvs={environments ?? []}
							canDeployOnClawdi={hostedAccess.canCreateCloudAgents}
							showCloudDeployments={cloudDeploymentManagementEnabled}
							showLegacyAgents={legacyHostedAgentsEnabled}
						/>
					</Suspense>
				) : ossIsEmptyState ? (
					<OnboardingCard />
				) : (
					<AgentsCard
						agents={selfManagedTiles}
						isLoading={envsLoading}
						error={blockingEnvsError}
						onRetry={() => {
							void refetchEnvs();
						}}
					/>
				)
			}
			activity={
				blockingStatsError ? (
					<ApiErrorPanel
						error={blockingStatsError}
						onRetry={() => {
							void refetchStats();
						}}
						title={OVERVIEW_COPY.activityError}
					/>
				) : statsLoading ? (
					<ActivityGraphSkeleton />
				) : contribution ? (
					<ContributionGraph data={contribution} />
				) : null
			}
			aside={
				<>
					{hostedAccessLoading ? null : hostedSectionEnabled && HostedSecondaryCTA ? (
						<Suspense fallback={null}>
							<HostedSecondaryCTA
								envsLoading={envsLoading}
								cloudEnvs={environments ?? []}
								canDeployOnClawdi={hostedAccess.canCreateCloudAgents}
								showCloudDeployments={cloudDeploymentManagementEnabled}
								showLegacyAgents={legacyHostedAgentsEnabled}
							/>
						</Suspense>
					) : hasAgents ? (
						<ConnectAnotherCard />
					) : null}
					<ResourcesCard
						stats={stats}
						statsError={blockingStatsError}
						onRetryStats={() => {
							void refetchStats();
						}}
					/>
					<ThisWeekCard
						stats={stats}
						error={blockingStatsError}
						onRetry={() => {
							void refetchStats();
						}}
					/>
				</>
			}
			sessions={
				blockingSessionsError ? (
					<ApiErrorPanel
						error={blockingSessionsError}
						onRetry={() => {
							void refetchSessions();
						}}
						title={OVERVIEW_COPY.recentSessionsError}
					/>
				) : (
					<SessionFeed
						sessions={sessions ?? []}
						isLoading={sessionsLoading}
						grouped={false}
						emptyMessage={OVERVIEW_COPY.manualSessionsEmpty}
						emptyVariant="inset"
					/>
				)
			}
		/>
	);
}

/** Overview grid shared by the page and its auth-loading skeleton so both
 * phases render the same shape. */
function OverviewLayout({
	greeting,
	agents,
	activity,
	aside,
	sessions,
}: {
	greeting: ReactNode;
	agents: ReactNode;
	activity: ReactNode;
	aside: ReactNode;
	sessions: ReactNode;
}) {
	return (
		<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, dashboardPageClasses.root)}>
			{greeting}

			<div className={dashboardPageClasses.grid}>
				<div className={dashboardPageClasses.agents}>{agents}</div>

				<section className={dashboardPageClasses.activity}>
					<h2 className={dashboardPageClasses.sectionTitle}>{OVERVIEW_COPY.activity}</h2>
					<Card>
						<CardContent>{activity}</CardContent>
					</Card>
				</section>

				{/* This source order is also the mobile reading and focus order. */}
				<div className={dashboardPageClasses.sidebar}>{aside}</div>

				<section className={dashboardPageClasses.recentSessions}>
					<div className={dashboardPageClasses.recentSessionsHeader}>
						<h2 className={dashboardPageClasses.sectionTitle}>{OVERVIEW_COPY.recentSessions}</h2>
						<Button
							render={<Link to="/sessions" />}
							nativeButton={false}
							variant="ghost"
							size="sm"
							className={dashboardPageClasses.viewAll}
						>
							{OVERVIEW_COPY.viewAll}
							<ArrowRight />
						</Button>
					</div>
					{sessions}
				</section>
			</div>
		</div>
	);
}

/** Overview placeholder shown while auth resolves, before the page mounts. */
export function DashboardPageSkeleton() {
	return (
		<OverviewLayout
			greeting={<GreetingSkeleton />}
			agents={<AgentsCard agents={[]} isLoading />}
			activity={<ActivityGraphSkeleton />}
			aside={
				<>
					<ResourcesCard stats={undefined} />
					<ThisWeekCard stats={undefined} />
				</>
			}
			sessions={<SessionFeed sessions={[]} isLoading grouped={false} emptyMessage="" />}
		/>
	);
}

function ActivityGraphSkeleton() {
	return (
		<div className={dashboardPageClasses.graphSkeleton}>
			{/* Centered like ContributionGraph so the grid doesn't shift on load. */}
			<div className={dashboardPageClasses.graphSkeletonLayout}>
				<div className={dashboardPageClasses.graphSkeletonWeekdays}>
					{Array.from({ length: 7 }).map((_, index) => (
						<Skeleton key={index} className={dashboardPageClasses.graphSkeletonWeekday} />
					))}
				</div>
				<div className={dashboardPageClasses.graphSkeletonBody}>
					<div className={dashboardPageClasses.graphSkeletonWeeks}>
						{Array.from({ length: 52 }).map((_, weekIndex) => (
							<div key={weekIndex} className={dashboardPageClasses.graphSkeletonWeek}>
								{Array.from({ length: 7 }).map((_, dayIndex) => (
									<Skeleton
										key={dayIndex}
										className={cn(
											dashboardPageClasses.graphSkeletonCell,
											(weekIndex + dayIndex) % 5 === 0 &&
												dashboardPageClasses.graphSkeletonMutedCell,
										)}
									/>
								))}
							</div>
						))}
					</div>
					<div className={dashboardPageClasses.graphSkeletonMonths}>
						{Array.from({ length: 6 }).map((_, index) => (
							<Skeleton key={index} className={dashboardPageClasses.graphSkeletonMonth} />
						))}
					</div>
				</div>
			</div>
		</div>
	);
}

/** Slim replacement for the embedded wizard duplicate (taste audit round
 * 2): one line + one button that opens the same Add-agent dialog. */
function ConnectAnotherCard() {
	const desktop = useDesktopShell();
	const [open, setOpen] = useState(false);
	return (
		<Card className={dashboardPageClasses.connectCard}>
			<CardContent className={dashboardPageClasses.connectCardContent}>
				<div className={dashboardPageClasses.connectCardTitle}>{OVERVIEW_COPY.connectAnother}</div>
				<Button
					size="sm"
					variant="outline"
					onClick={() => (desktop.inDesktop ? desktop.openConnector() : setOpen(true))}
				>
					{OVERVIEW_COPY.addAgent}
				</Button>
			</CardContent>
			<AddAgentDialog open={open} onClose={() => setOpen(false)} />
		</Card>
	);
}

/** Personal time-of-day greeting. */

function Greeting() {
	const { user, isLoaded } = useCurrentUser();
	const [daypart, setDaypart] = useState<ReturnType<typeof currentDaypart> | null>(null);
	useEffect(() => {
		setDaypart(currentDaypart());
	}, []);
	const firstName = user?.fullName?.split(" ")[0];
	return (
		<div>
			<h1 className={dashboardPageClasses.greeting}>
				{daypart && isLoaded ? (
					dashboardGreeting(daypart, firstName)
				) : (
					<Skeleton className={dashboardPageClasses.greetingSkeleton} />
				)}
			</h1>
		</div>
	);
}

function GreetingSkeleton() {
	return (
		<div>
			<h1 className={dashboardPageClasses.greeting}>
				<Skeleton className={dashboardPageClasses.greetingSkeleton} />
			</h1>
		</div>
	);
}
