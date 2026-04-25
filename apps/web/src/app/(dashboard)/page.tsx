"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AgentsCard } from "@/components/dashboard/agents-card";
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

const RECENT_SESSIONS_LIMIT = 15;

export default function DashboardPage() {
	const api = useApi();
	const router = useRouter();

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

	// Zero-state promotion: when the user has no agents yet, the primary CTA
	// (connect one) belongs in the hero slot — not tucked into the sidebar
	// behind an empty "Agents" card that tells them to "use the panel below".
	const hasAgents = !envsLoading && (environments?.length ?? 0) > 0;
	const isEmptyState = !envsLoading && (environments?.length ?? 0) === 0;

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
					{isEmptyState ? (
						<OnboardingCard />
					) : (
						<AgentsCard environments={environments} isLoading={envsLoading} />
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
							onRowClick={(s) => router.push(`/sessions/${s.id}`)}
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

				{/* Right column — once agents exist, "Connect another" lives here
				    as a secondary action. Empty state hides it entirely because
				    the hero card above is already the onboarding. */}
				<div className="min-w-0 space-y-4">
					{hasAgents ? <OnboardingCard /> : null}
					<ResourcesCard stats={stats} />
					<ThisWeekCard stats={stats} contribution={contribution} />
				</div>
			</div>
		</div>
	);
}
