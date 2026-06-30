"use client";

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { AddAgentDialog } from "@/components/dashboard/add-agent-dialog";
import {
	AgentsCard,
	isAgentActive,
	selfManagedAgentTiles,
} from "@/components/dashboard/agents-card";
import { ContributionGraph } from "@/components/dashboard/contribution-graph";
import { OnboardingCard } from "@/components/dashboard/onboarding-card";
import { type ProjectTypeCounts, ResourcesCard } from "@/components/dashboard/resources-card";
import { ThisWeekCard } from "@/components/dashboard/this-week-card";
import { SessionFeed } from "@/components/sessions/session-feed";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { unwrap, useApi } from "@/lib/api";
import { useCurrentUser } from "@/lib/auth-client";
import { sessionListQueryOptions } from "@/lib/session-queries";
import { relativeTime } from "@/lib/utils";
import { useV2Access } from "@/lib/v2-access";

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

export default function DashboardPage() {
	const api = useApi();
	const v2Access = useV2Access();

	const { data: stats, isLoading: statsLoading } = useQuery({
		queryKey: ["dashboard-stats"],
		queryFn: async () => unwrap(await api.GET("/api/dashboard/stats")),
		staleTime: DASHBOARD_STALE_MS,
	});

	const { data: projects, isLoading: projectsLoading } = useQuery({
		queryKey: ["projects"],
		queryFn: async () => unwrap(await api.GET("/api/projects")),
		staleTime: DASHBOARD_STALE_MS,
	});

	const { data: environments, isLoading: envsLoading } = useQuery({
		queryKey: ["environments"],
		queryFn: async () => unwrap(await api.GET("/api/environments")),
		// Daemon-status badge classification is time-sensitive — a
		// daemon that paused while the tab was open would otherwise
		// stay green indefinitely. Match the agent detail page's
		// 10s cadence so the live indicator is actually live.
		refetchInterval: 10_000,
	});

	// Manual sessions only: on a working fleet ~3/4 of sessions are
	// cron/heartbeat ticks, and "Recent sessions" buried the user's own
	// work under them. Automation is one click away via View all.
	const { data: sessionsPage, isLoading: sessionsLoading } = useQuery(
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
	const fleetAgents = environments ?? [];
	const fleetLastActive =
		fleetAgents
			.map((env) => env.last_seen_at)
			.filter((value): value is string => Boolean(value))
			.sort((a, b) => b.localeCompare(a))[0] ?? null;

	// Zero-state promotion: when the user has no agents yet, the
	// secondary CTA (connect one) lives in the right column. The
	// hosted code path may still render an AgentsCard if the user has
	// hosted deployments — that decision lives inside
	// `<HostedAgentsSection>` so this page doesn't need the hosted
	// counts at all.
	const selfManagedCount = selfManagedTiles.length;
	const hasAgents = !envsLoading && selfManagedCount > 0;
	const ossIsEmptyState = !envsLoading && selfManagedCount === 0;
	const projectTypeCounts = useMemo(() => countProjectTypes(projects), [projects]);
	const hostedAccessLoading = Boolean(HostedAgentsSection && v2Access.isLoading);
	const hostedAgentsEnabled = Boolean(HostedAgentsSection && v2Access.canUseV2);

	return (
		<div className="space-y-5 px-4 lg:px-6">
			<Greeting
				activeCount={fleetAgents.filter((env) => isAgentActive(env.last_seen_at)).length}
				total={fleetAgents.length}
				lastActive={fleetLastActive}
			/>

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
					) : hostedAgentsEnabled && HostedAgentsSection ? (
						<Suspense fallback={<AgentsCard agents={selfManagedTiles} isLoading />}>
							<HostedAgentsSection
								selfManagedTiles={selfManagedTiles}
								envsLoading={envsLoading}
								selfManagedCount={selfManagedCount}
								cloudEnvs={environments ?? []}
							/>
						</Suspense>
					) : ossIsEmptyState ? (
						<OnboardingCard />
					) : (
						<AgentsCard agents={selfManagedTiles} isLoading={envsLoading} />
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
							{statsLoading ? (
								<Skeleton className="h-28 w-full rounded-md" />
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
							<Button asChild variant="ghost" size="sm" className="text-muted-foreground">
								<Link to="/sessions" search={{ automated: false }}>
									View all
									<ArrowRight />
								</Link>
							</Button>
						</div>
						<SessionFeed
							sessions={sessions ?? []}
							isLoading={sessionsLoading}
							grouped={false}
							emptyMessage="No sessions yet. Once your agent starts a conversation, it'll show up here."
						/>
					</section>
				</div>

				{/* Right column — once any agent exists (hosted OR self-managed),
				    "Connect another" lives here as a secondary action. Empty
				    state hides it entirely because the hero card above is
				    already the onboarding. Hosted mode delegates the decision
				    to a sibling component so it can include hosted tiles in
				    the count. */}
				<div className="min-w-0 space-y-4">
					{hostedAccessLoading ? null : hostedAgentsEnabled && HostedSecondaryCTA ? (
						<Suspense fallback={null}>
							<HostedSecondaryCTA
								selfManagedCount={selfManagedCount}
								envsLoading={envsLoading}
								cloudEnvs={environments ?? []}
							/>
						</Suspense>
					) : hasAgents ? (
						<ConnectAnotherCard />
					) : null}
					<ResourcesCard
						stats={stats}
						projectCount={projects?.length}
						projectTypeCounts={projectTypeCounts}
						projectCountLoading={projectsLoading}
						hasConnectedAgent={
							hostedAccessLoading || hostedAgentsEnabled || envsLoading ? undefined : hasAgents
						}
					/>
					<ThisWeekCard stats={stats} contribution={contribution} />
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
}: {
	activeCount: number;
	total: number;
	/** Most recent last-seen timestamp across the fleet — the one fact the
	 * old AgentsCard header carried that the greeting didn't. */
	lastActive?: string | null;
}) {
	const { user } = useCurrentUser();
	const [daypart, setDaypart] = useState<ReturnType<typeof currentDaypart> | null>(null);
	useEffect(() => {
		setDaypart(currentDaypart());
	}, []);
	const firstName = user?.fullName?.split(" ")[0];
	const summary =
		total === 0
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
