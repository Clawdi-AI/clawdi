"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useMemo } from "react";
import { AgentsCard, type AgentTile, isAgentActive } from "@/components/dashboard/agents-card";
import { ContributionGraph } from "@/components/dashboard/contribution-graph";
import { OnboardingCard } from "@/components/dashboard/onboarding-card";
import { ResourcesCard } from "@/components/dashboard/resources-card";
import { ThisWeekCard } from "@/components/dashboard/this-week-card";
import { PageHeader } from "@/components/page-header";
import { sessionColumnsCompact } from "@/components/sessions/session-columns";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { Skeleton } from "@/components/ui/skeleton";
import { unwrap, useApi } from "@/lib/api";
import { IS_HOSTED } from "@/lib/hosted";
import { relativeTime } from "@/lib/utils";

const RECENT_SESSIONS_LIMIT = 15;

// Dynamic imports gated on a build-time-constant `IS_HOSTED`. When
// the flag is false (OSS), the conditional collapses, the
// `dynamic(…)` calls are unreachable, the bundler eliminates the
// `import()` sites, and the entire `@/hosted/hosted-agents-section`
// chunk — along with its `clawdi-api.ts` and `use-hosted-agent-tiles`
// dependencies — never ships in the OSS bundle.
//
// Two exports from the same module: `HostedAgentsSection` for the
// left-column agent panel, and `HostedSecondaryCTA` for the
// right-column "Connect another" CTA. Both call
// `useHostedAgentTiles` and share its TanStack Query cache, so
// rendering both still costs only one network request.
const HostedAgentsSection = IS_HOSTED
	? dynamic(() =>
			import("@/hosted/hosted-agents-section").then((m) => ({
				default: m.HostedAgentsSection,
			})),
		)
	: null;
const HostedSecondaryCTA = IS_HOSTED
	? dynamic(() =>
			import("@/hosted/hosted-agents-section").then((m) => ({
				default: m.HostedSecondaryCTA,
			})),
		)
	: null;

export default function DashboardPage() {
	const api = useApi();

	const { data: stats } = useQuery({
		queryKey: ["dashboard-stats"],
		queryFn: async () => unwrap(await api.GET("/api/dashboard/stats")),
	});

	const { data: environments, isLoading: envsLoading } = useQuery({
		queryKey: ["environments"],
		queryFn: async () => unwrap(await api.GET("/api/environments")),
	});

	const { data: contribution, isLoading: contribLoading } = useQuery({
		queryKey: ["dashboard-contribution"],
		queryFn: async () => unwrap(await api.GET("/api/dashboard/contribution")),
	});

	const { data: sessionsPage, isLoading: sessionsLoading } = useQuery({
		queryKey: ["recent-sessions"],
		queryFn: async () =>
			unwrap(
				await api.GET("/api/sessions", {
					params: { query: { page_size: RECENT_SESSIONS_LIMIT } },
				}),
			),
	});
	const sessions = sessionsPage?.items;

	const streakLine =
		stats && stats.current_streak > 0
			? `Current streak: ${stats.current_streak} day${stats.current_streak === 1 ? "" : "s"}`
			: null;

	const selfManagedTiles: AgentTile[] = useMemo(() => {
		return (environments ?? []).map((env) => ({
			id: env.id,
			source: "self-managed" as const,
			name: env.machine_name,
			agentType: env.agent_type,
			runtimeLabel: `${formatRuntime(env.agent_type)} · ${inferMode(env.agent_type)}`,
			statusLabel: env.last_seen_at ? `Synced ${relativeTime(env.last_seen_at)}` : "Never seen",
			lastSeenAt: env.last_seen_at,
			href: `/agents/${env.id}`,
			active: isAgentActive(env.last_seen_at),
		}));
	}, [environments]);

	// Zero-state promotion: when the user has no agents yet, the
	// secondary CTA (connect one) lives in the right column. The
	// hosted code path may still render an AgentsCard if the user has
	// deployed agents on clawdi.ai — that decision lives inside
	// `<HostedAgentsSection>` so this page doesn't need the hosted
	// counts at all.
	const selfManagedCount = environments?.length ?? 0;
	const hasAgents = !envsLoading && selfManagedCount > 0;
	const ossIsEmptyState = !envsLoading && selfManagedCount === 0;

	return (
		<div className="space-y-5 px-4 lg:px-6">
			<PageHeader title="Overview" description="Your agent cloud at a glance." />

			<div className="grid gap-4 lg:grid-cols-3">
				{/* Left column — live status + activity. `min-w-0` is load-bearing:
				    grid items default to `min-width: auto` (= min-content), so a
				    fixed-width child (table-fixed table, code block, etc.) makes
				    the grid track grow past its declared 1fr/2fr share. Below the
				    `lg` breakpoint that means single-column overflow → cards
				    spill past the viewport. */}
				<div className="min-w-0 space-y-4 lg:col-span-2">
					{HostedAgentsSection ? (
						<HostedAgentsSection
							selfManagedTiles={selfManagedTiles}
							envsLoading={envsLoading}
							selfManagedCount={selfManagedCount}
						/>
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
							{contribLoading ? (
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
								<p className="text-sm text-muted-foreground">Latest syncs from your agents.</p>
							</div>
							<Button asChild variant="ghost" size="sm" className="text-muted-foreground">
								<Link href="/sessions">
									View all
									<ArrowRight />
								</Link>
							</Button>
						</div>
						<DataTable
							columns={sessionColumnsCompact}
							data={sessions ?? []}
							isLoading={sessionsLoading}
							getRowHref={(s) => `/sessions/${s.id}`}
							rowAriaLabel={(s) => `Open session ${s.local_session_id}`}
							emptyMessage={
								<>
									No sessions yet. Run{" "}
									<code className="rounded bg-muted px-1.5 py-0.5 text-xs">clawdi push</code> on a
									connected agent.
								</>
							}
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
					{HostedSecondaryCTA ? (
						<HostedSecondaryCTA selfManagedCount={selfManagedCount} envsLoading={envsLoading} />
					) : hasAgents ? (
						<OnboardingCard />
					) : null}
					<ResourcesCard stats={stats} />
					<ThisWeekCard stats={stats} contribution={contribution} />
				</div>
			</div>
		</div>
	);
}

function formatRuntime(agentType: string): string {
	switch (agentType) {
		case "openclaw":
			return "OpenClaw";
		case "hermes":
			return "Hermes";
		case "claude_code":
		case "claude-code":
			return "Claude Code";
		case "codex":
			return "Codex";
		default:
			return agentType;
	}
}

function inferMode(agentType: string): "Daemon" | "CLI" {
	// OpenClaw and Hermes are long-running daemon processes; the rest
	// (Claude Code, Codex) are stdio CLI tools invoked per command.
	if (agentType === "openclaw" || agentType === "hermes") return "Daemon";
	return "CLI";
}
