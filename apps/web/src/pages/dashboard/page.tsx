"use client";

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { AddAgentDialog } from "@/components/dashboard/add-agent-dialog";
import { AgentsCard, selfManagedAgentTiles } from "@/components/dashboard/agents-card";
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
		<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, "space-y-5 px-4 lg:px-6")}>
			<Greeting />

			<div className="grid gap-4 lg:grid-cols-3">
				<div className="min-w-0 lg:col-span-2 lg:row-start-1">
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

				<section className="min-w-0 space-y-2 lg:col-span-2 lg:row-start-2">
					<h2 className="text-base font-semibold">Activity</h2>
					<Card>
						<CardContent>
							{blockingStatsError ? (
								<ApiErrorPanel
									error={blockingStatsError}
									onRetry={() => {
										void refetchStats();
									}}
									title="Couldn't load activity"
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
				<div className="min-w-0 space-y-4 lg:col-start-3 lg:row-span-3 lg:row-start-1">
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

				<section className="min-w-0 space-y-2 lg:col-span-2 lg:row-start-3">
					<div className="flex items-end justify-between">
						<h2 className="text-base font-semibold">Recent sessions</h2>
						<Button
							render={<Link to="/sessions" />}
							nativeButton={false}
							variant="ghost"
							size="sm"
							className="text-muted-foreground"
						>
							View all
							<ArrowRight />
						</Button>
					</div>
					{blockingSessionsError ? (
						<ApiErrorPanel
							error={blockingSessionsError}
							onRetry={() => {
								void refetchSessions();
							}}
							title="Couldn't load recent sessions"
						/>
					) : (
						<SessionFeed
							sessions={sessions ?? []}
							isLoading={sessionsLoading}
							grouped={false}
							emptyMessage="No manual sessions yet. Once you start a conversation, it'll show up here."
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
		<div className="w-full">
			<div className="flex gap-1.5">
				<div className="flex w-3 shrink-0 flex-col items-center gap-[3px]">
					{Array.from({ length: 7 }).map((_, index) => (
						<Skeleton key={index} className="h-[11px] w-2 rounded-[3px]" />
					))}
				</div>
				<div className="min-w-0 flex-1">
					<div className="flex max-h-[95px] overflow-hidden gap-[3px]">
						{Array.from({ length: 52 }).map((_, weekIndex) => (
							<div key={weekIndex} className="flex flex-col gap-[3px]">
								{Array.from({ length: 7 }).map((_, dayIndex) => (
									<Skeleton
										key={dayIndex}
										className={cn(
											"size-[11px] rounded-[3px]",
											(weekIndex + dayIndex) % 5 === 0 && "opacity-50",
										)}
									/>
								))}
							</div>
						))}
					</div>
					<div className="mt-1 flex h-4 items-center gap-10">
						{Array.from({ length: 6 }).map((_, index) => (
							<Skeleton key={index} className="h-2.5 w-6" />
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
	const [open, setOpen] = useState(false);
	return (
		<Card className="py-4">
			<CardContent className="flex items-center justify-between gap-3 px-4">
				<div className="min-w-0 text-sm font-medium">Connect another machine</div>
				<Button size="sm" variant="outline" onClick={() => setOpen(true)}>
					Add agent
				</Button>
			</CardContent>
			<AddAgentDialog open={open} onClose={() => setOpen(false)} />
		</Card>
	);
}

/** Personal time-of-day greeting. */
function currentDaypart(): "morning" | "afternoon" | "evening" {
	const hour = new Date().getHours();
	return hour < 5 ? "evening" : hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
}

function Greeting() {
	const { user, isLoaded } = useCurrentUser();
	const [daypart, setDaypart] = useState<ReturnType<typeof currentDaypart> | null>(null);
	useEffect(() => {
		setDaypart(currentDaypart());
	}, []);
	const firstName = user?.fullName?.split(" ")[0];
	return (
		<div>
			<h1 className="text-2xl font-semibold tracking-tight">
				{daypart && isLoaded ? (
					`Good ${daypart}${firstName ? `, ${firstName}` : ""}`
				) : (
					<Skeleton className="h-8 w-64 max-w-full" />
				)}
			</h1>
		</div>
	);
}
