"use client";

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { AddAgentDialog } from "@/components/dashboard/add-agent-dialog";
import {
	type AgentFleetSummary,
	AgentsCard,
	fleetSummaryFromTiles,
	selfManagedAgentTiles,
} from "@/components/dashboard/agents-card";
import { ContributionGraph } from "@/components/dashboard/contribution-graph";
import { OnboardingCard } from "@/components/dashboard/onboarding-card";
import { type ProjectTypeCounts, ResourcesCard } from "@/components/dashboard/resources-card";
import { ThisWeekCard } from "@/components/dashboard/this-week-card";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import { SessionFeed } from "@/components/sessions/session-feed";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { unwrap, useApi } from "@/lib/api";
import { useCurrentUser } from "@/lib/auth-client";
import { useHostedProductAccess } from "@/lib/hosted-product-access";
import { sessionListQueryOptions } from "@/lib/session-queries";
import { cn, relativeTime } from "@/lib/utils";

const RECENT_SESSIONS_LIMIT = 15;
const RECENT_SESSIONS_CACHE_PAGE_SIZE = 25;
const DASHBOARD_STALE_MS = 30_000;
const IS_HOSTED_BUILD = import.meta.env.VITE_CLAWDI_HOSTED === "true";

function countProjectTypes(
	projects: Array<{ kind?: string | null }> | undefined,
): ProjectTypeCounts {
	const counts: ProjectTypeCounts = { custom: 0, global: 0, agent: 0 };
	for (const project of projects ?? []) {
		if (project.kind === "personal") {
			counts.global += 1;
		} else if (project.kind === "environment") {
			counts.agent += 1;
		} else {
			counts.custom += 1;
		}
	}
	return counts;
}

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
const HostedFleetSummary = IS_HOSTED_BUILD
	? lazy(() =>
			import("@/hosted/use-hosted-agent-tiles").then((m) => ({
				default: m.HostedFleetSummary,
			})),
		)
	: null;

export default function DashboardPage() {
	const api = useApi();
	const hostedAccess = useHostedProductAccess();

	const {
		data: stats,
		isLoading: statsLoading,
		error: statsError,
		refetch: refetchStats,
	} = useQuery({
		queryKey: ["dashboard-stats"],
		queryFn: async () => unwrap(await api.GET("/v1/dashboard/stats")),
		// Overview counts are cheap and reflect recent mutations across many
		// resources, so keep this query fresher than the global 30s default.
		staleTime: 0,
		refetchOnMount: "always",
	});

	const {
		data: projects,
		isLoading: projectsLoading,
		error: projectsError,
		refetch: refetchProjects,
	} = useQuery({
		queryKey: ["projects"],
		queryFn: async () => unwrap(await api.GET("/v1/projects")),
		staleTime: DASHBOARD_STALE_MS,
	});

	const {
		data: environments,
		isLoading: envsLoading,
		error: envsError,
		refetch: refetchEnvs,
	} = useQuery({
		queryKey: ["agents"],
		queryFn: async () => unwrap(await api.GET("/v1/agents")),
		// Daemon-status badge classification is time-sensitive — a
		// daemon that paused while the tab was open would otherwise
		// stay green indefinitely. Match the agent detail page's
		// 10s cadence so the live indicator is actually live.
		refetchInterval: 10_000,
	});

	// Manual sessions only: on a working fleet ~3/4 of sessions are
	// cron/heartbeat ticks, and "Recent sessions" buried the user's own
	// work under them. Automation is one click away via View all.
	const {
		data: sessionsPage,
		isLoading: sessionsLoading,
		error: sessionsError,
		refetch: refetchSessions,
	} = useQuery(
		sessionListQueryOptions(api, {
			page_size: RECENT_SESSIONS_CACHE_PAGE_SIZE,
			automated: false,
		}),
	);
	const sessions = sessionsPage?.items.slice(0, RECENT_SESSIONS_LIMIT);
	const contribution = stats?.contribution;

	const streakLine =
		stats && stats.current_streak > 0
			? `Current streak: ${stats.current_streak} day${stats.current_streak === 1 ? "" : "s"}`
			: null;

	const selfManagedTiles = useMemo(() => selfManagedAgentTiles(environments), [environments]);
	const selfManagedFleetSummary = useMemo(
		() => fleetSummaryFromTiles(selfManagedTiles),
		[selfManagedTiles],
	);

	// Zero-state promotion: when the user has no agents yet, the
	// secondary CTA (connect one) lives in the right column. The
	// hosted code path may still render an AgentsCard if the user has
	// hosted deployments — that decision lives inside
	// `<HostedAgentsSection>` so this page doesn't need the hosted
	// counts at all.
	const selfManagedCount = selfManagedTiles.length;
	const hasAgents = !envsLoading && !envsError && selfManagedCount > 0;
	const ossIsEmptyState = !envsLoading && !envsError && selfManagedCount === 0;
	const projectTypeCounts = useMemo(
		() => (projects ? countProjectTypes(projects) : undefined),
		[projects],
	);
	const hostedAccessLoading = Boolean(HostedAgentsSection && hostedAccess.isLoading);
	const hostedAgentsEnabled = Boolean(HostedAgentsSection && hostedAccess.canUseCloudAgents);
	const legacyHostedAgentsEnabled = Boolean(
		HostedAgentsSection && hostedAccess.canUseLegacyHostedDashboard,
	);
	const hostedSectionEnabled = hostedAgentsEnabled || legacyHostedAgentsEnabled;
	const greeting = renderGreeting(selfManagedFleetSummary, {
		agentStatusUnavailable: Boolean(envsError),
	});

	return (
		<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, "space-y-5 px-4 lg:px-6")}>
			{hostedAccessLoading ? (
				greeting
			) : hostedSectionEnabled && HostedFleetSummary ? (
				<Suspense fallback={greeting}>
					<HostedFleetSummary
						selfManagedTiles={selfManagedTiles}
						cloudEnvs={environments ?? []}
						showCloudDeployments={hostedAgentsEnabled}
						showLegacyAgents={legacyHostedAgentsEnabled}
					>
						{(summary) =>
							renderGreeting(summary, {
								agentStatusUnavailable: Boolean(envsError) && summary.total === 0,
							})
						}
					</HostedFleetSummary>
				</Suspense>
			) : (
				greeting
			)}

			<div className="grid gap-4 lg:grid-cols-3">
				{/* Left column — live status + activity. `min-w-0` is load-bearing:
				    grid items default to `min-width: auto` (= min-content), so a
				    fixed-width child (table-fixed table, code block, etc.) makes
				    the grid track grow past its declared 1fr/2fr share. Below the
				    `lg` breakpoint that means single-column overflow → cards
				    spill past the viewport. */}
				<div className="min-w-0 space-y-4 lg:col-span-2">
					{hostedAccessLoading ? (
						<AgentsCard agents={selfManagedTiles} isLoading />
					) : hostedSectionEnabled && HostedAgentsSection ? (
						<Suspense fallback={<AgentsCard agents={selfManagedTiles} isLoading />}>
							<HostedAgentsSection
								selfManagedTiles={selfManagedTiles}
								envsLoading={envsLoading}
								selfManagedError={envsError}
								onRetrySelfManaged={() => {
									void refetchEnvs();
								}}
								selfManagedCount={selfManagedCount}
								cloudEnvs={environments ?? []}
								showCloudDeployments={hostedAgentsEnabled}
								showLegacyAgents={legacyHostedAgentsEnabled}
							/>
						</Suspense>
					) : ossIsEmptyState ? (
						<OnboardingCard />
					) : (
						<AgentsCard
							agents={selfManagedTiles}
							isLoading={envsLoading}
							error={envsError}
							onRetry={() => {
								void refetchEnvs();
							}}
						/>
					)}

					<Card>
						<CardHeader>
							<CardTitle>Activity</CardTitle>
							<CardDescription>
								Sessions per day in the last 12 months
								{streakLine ? ` · ${streakLine}` : ""}
							</CardDescription>
						</CardHeader>
						<CardContent>
							{statsError ? (
								<ApiErrorPanel
									error={statsError}
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

					<section className="space-y-2">
						<div className="flex items-end justify-between">
							<div>
								<h2 className="text-base font-semibold">Recent sessions</h2>
								<p className="text-sm text-muted-foreground">
									Your latest work — automated runs live under View all.
								</p>
							</div>
							<Button
								render={<Link to="/sessions" search={{ automated: false }} />}
								nativeButton={false}
								variant="ghost"
								size="sm"
								className="text-muted-foreground"
							>
								View all
								<ArrowRight />
							</Button>
						</div>
						{sessionsError ? (
							<ApiErrorPanel
								error={sessionsError}
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
								emptyMessage="No sessions yet. Once your agent starts a conversation, it'll show up here."
								emptyVariant="inset"
							/>
						)}
					</section>
				</div>

				{/* Right column — once any agent exists (hosted OR self-managed),
				    "Connect another" lives here as a secondary action. Empty
				    state hides it entirely because the hero card above is
				    already the onboarding. Hosted mode delegates the decision
				    to a sibling component so it can include hosted tiles in
				    the count. */}
				<div className="min-w-0 space-y-4">
					{hostedAccessLoading ? null : hostedSectionEnabled && HostedSecondaryCTA ? (
						<Suspense fallback={null}>
							<HostedSecondaryCTA
								selfManagedCount={selfManagedCount}
								envsLoading={envsLoading}
								cloudEnvs={environments ?? []}
								showCloudDeployments={hostedAgentsEnabled}
								showLegacyAgents={legacyHostedAgentsEnabled}
							/>
						</Suspense>
					) : hasAgents ? (
						<ConnectAnotherCard />
					) : null}
					<ResourcesCard
						stats={stats}
						statsError={statsError}
						onRetryStats={() => {
							void refetchStats();
						}}
						projectCount={projects?.length}
						projectTypeCounts={projectTypeCounts}
						projectCountLoading={projectsLoading}
						projectCountError={projectsError}
						onRetryProjectCount={() => {
							void refetchProjects();
						}}
						hasConnectedAgent={
							hostedAccessLoading || hostedSectionEnabled || envsLoading || envsError
								? undefined
								: hasAgents
						}
					/>
					<ThisWeekCard
						stats={stats}
						contribution={contribution}
						error={statsError}
						onRetry={() => {
							void refetchStats();
						}}
					/>
				</div>
			</div>
		</div>
	);
}

function renderGreeting(
	summary: AgentFleetSummary,
	options: { agentStatusUnavailable?: boolean } = {},
) {
	return (
		<Greeting
			activeCount={summary.activeCount}
			total={summary.total}
			lastActive={summary.lastActive}
			agentStatusUnavailable={options.agentStatusUnavailable}
		/>
	);
}

function ActivityGraphSkeleton() {
	return (
		<div className="w-full">
			<div className="flex gap-1.5">
				<div className="flex w-[22px] shrink-0 flex-col gap-[3px] pt-5">
					{Array.from({ length: 7 }).map((_, index) => (
						<Skeleton
							key={index}
							className={cn("h-[11px] rounded-sm", index % 2 === 1 ? "w-5" : "w-2")}
						/>
					))}
				</div>
				<div className="min-w-0 flex-1">
					<div className="mb-1 flex h-4 items-center gap-10">
						{Array.from({ length: 6 }).map((_, index) => (
							<Skeleton key={index} className="h-2.5 w-6" />
						))}
					</div>
					<div className="flex max-h-[95px] overflow-hidden gap-[3px]">
						{Array.from({ length: 52 }).map((_, weekIndex) => (
							<div key={weekIndex} className="flex flex-col gap-[3px]">
								{Array.from({ length: 7 }).map((_, dayIndex) => (
									<Skeleton
										key={dayIndex}
										className={cn(
											"size-[11px] rounded-sm",
											(weekIndex + dayIndex) % 5 === 0 && "opacity-50",
										)}
									/>
								))}
							</div>
						))}
					</div>
				</div>
			</div>
			<div className="mt-3 flex justify-end gap-1.5">
				<Skeleton className="h-3 w-7" />
				{Array.from({ length: 5 }).map((_, index) => (
					<Skeleton key={index} className="size-[11px] rounded-sm" />
				))}
				<Skeleton className="h-3 w-8" />
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
				<div className="min-w-0">
					<div className="text-sm font-medium">Connect another machine</div>
					<p className="mt-0.5 text-xs text-muted-foreground">One command in a terminal.</p>
				</div>
				<Button size="sm" variant="outline" onClick={() => setOpen(true)}>
					Add agent
				</Button>
			</CardContent>
			<AddAgentDialog open={open} onClose={() => setOpen(false)} />
		</Card>
	);
}

/** Time-of-day greeting — personal, no emoji, one quiet fleet summary line. */
function currentDaypart(): "morning" | "afternoon" | "evening" {
	const hour = new Date().getHours();
	return hour < 5 ? "evening" : hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
}

function Greeting({
	activeCount,
	total,
	lastActive,
	agentStatusUnavailable = false,
}: {
	activeCount: number;
	total: number;
	/** Most recent last-seen timestamp across the fleet — the one fact the
	 * old AgentsCard header carried that the greeting didn't. */
	lastActive?: string | null;
	agentStatusUnavailable?: boolean;
}) {
	const { user } = useCurrentUser();
	const [daypart, setDaypart] = useState<ReturnType<typeof currentDaypart> | null>(null);
	useEffect(() => {
		setDaypart(currentDaypart());
	}, []);
	const firstName = user?.fullName?.split(" ")[0];
	const summary = agentStatusUnavailable
		? "Agent status is unavailable right now."
		: total === 0
			? "Connect your first agent to start syncing."
			: activeCount > 0
				? `${activeCount} of ${total} agents active right now.`
				: `${total} agents connected${lastActive ? ` · last active ${relativeTime(lastActive)}` : ""}.`;
	return (
		<div>
			<h1 className="text-2xl font-semibold tracking-tight">
				{daypart ? `Good ${daypart}` : "Welcome"}
				{firstName ? `, ${firstName}` : ""}
			</h1>
			<p className="mt-1 text-sm text-muted-foreground tabular-nums">{summary}</p>
		</div>
	);
}
