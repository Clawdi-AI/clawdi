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
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
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
import { useDesktopBridge } from "@/lib/desktop";
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
		<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, dashboardPageClasses.spaceY5Px4)}>
			<Greeting />

			<div className={dashboardPageClasses.gridGap4LgGrid}>
				<div className={dashboardPageClasses.minW0LgCol}>
					{hostedAccessLoading ? (
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
					)}
				</div>

				<section className={dashboardPageClasses.minW0SpaceY}>
					<h2 className={dashboardPageClasses.textBaseFontSemibold}>{OVERVIEW_COPY.activity}</h2>
					<Card>
						<CardContent>
							{blockingStatsError ? (
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
							) : null}
						</CardContent>
					</Card>
				</section>

				{/* This source order is also the mobile reading and focus order. */}
				<div className={dashboardPageClasses.minW0SpaceY2}>
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
				</div>

				<section className={dashboardPageClasses.minW0SpaceY3}>
					<div className={dashboardPageClasses.flexItemsEndJustifyBetween}>
						<h2 className={dashboardPageClasses.textBaseFontSemibold}>
							{OVERVIEW_COPY.recentSessions}
						</h2>
						<Button
							render={<Link to="/sessions" />}
							nativeButton={false}
							variant="ghost"
							size="sm"
							className={dashboardPageClasses.textMutedForeground}
						>
							{OVERVIEW_COPY.viewAll}
							<ArrowRight />
						</Button>
					</div>
					{blockingSessionsError ? (
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
					)}
				</section>
			</div>
		</div>
	);
}

function ActivityGraphSkeleton() {
	return (
		<div className={dashboardPageClasses.wFull}>
			<div className={dashboardPageClasses.flexGap15}>
				<div className={dashboardPageClasses.flexW3Shrink0}>
					{Array.from({ length: 7 }).map((_, index) => (
						<Skeleton key={index} className={dashboardPageClasses.h11PxW2Rounded} />
					))}
				</div>
				<div className={dashboardPageClasses.minW0Flex1}>
					<div className={dashboardPageClasses.flexMaxH95PxOverflow}>
						{Array.from({ length: 52 }).map((_, weekIndex) => (
							<div key={weekIndex} className={dashboardPageClasses.flexFlexColGap3Px}>
								{Array.from({ length: 7 }).map((_, dayIndex) => (
									<Skeleton
										key={dayIndex}
										className={cn(
											dashboardPageClasses.size11PxRounded3Px,
											(weekIndex + dayIndex) % 5 === 0 && dashboardPageClasses.opacity50,
										)}
									/>
								))}
							</div>
						))}
					</div>
					<div className={dashboardPageClasses.mt1FlexH4}>
						{Array.from({ length: 6 }).map((_, index) => (
							<Skeleton key={index} className={dashboardPageClasses.h25W6} />
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
	const desktopBridge = useDesktopBridge();
	const [open, setOpen] = useState(false);
	const connectAgent = () => {
		if (desktopBridge) {
			void desktopBridge.openConnectWizard().catch(() => setOpen(true));
			return;
		}
		setOpen(true);
	};
	return (
		<Card className={dashboardPageClasses.py4}>
			<CardContent className={dashboardPageClasses.flexItemsCenterJustifyBetween}>
				<div className={dashboardPageClasses.minW0TextSm}>{OVERVIEW_COPY.connectAnother}</div>
				<Button size="sm" variant="outline" onClick={connectAgent}>
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
			<h1 className={dashboardPageClasses.text2XlFontSemiboldTracking}>
				{daypart && isLoaded ? (
					dashboardGreeting(daypart, firstName)
				) : (
					<Skeleton className={dashboardPageClasses.h8W64Max} />
				)}
			</h1>
		</div>
	);
}
