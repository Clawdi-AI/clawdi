"use client";

import { useAuth } from "@clerk/nextjs";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { AgentsCard } from "@/components/dashboard/agents-card";
import { ContributionGraph } from "@/components/dashboard/contribution-graph";
import { OnboardingCard } from "@/components/dashboard/onboarding-card";
import { ResourcesCard } from "@/components/dashboard/resources-card";
import { ThisWeekCard } from "@/components/dashboard/this-week-card";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { SessionRow, SessionRowSkeleton } from "@/components/sessions/session-row";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { apiFetch } from "@/lib/api";
import type {
	ContributionDay,
	DashboardStats,
	Environment,
	SessionListItem,
} from "@/lib/api-schemas";

const RECENT_SESSIONS_LIMIT = 5;

export default function DashboardPage() {
	const { getToken } = useAuth();

	const { data: stats } = useQuery({
		queryKey: ["dashboard-stats"],
		queryFn: async () => {
			const token = await getToken();
			if (!token) throw new Error("Not authenticated");
			return apiFetch<DashboardStats>("/api/dashboard/stats", token);
		},
	});

	const { data: environments, isLoading: envsLoading } = useQuery({
		queryKey: ["environments"],
		queryFn: async () => {
			const token = await getToken();
			if (!token) throw new Error("Not authenticated");
			return apiFetch<Environment[]>("/api/environments", token);
		},
	});

	const { data: contribution, isLoading: contribLoading } = useQuery({
		queryKey: ["dashboard-contribution"],
		queryFn: async () => {
			const token = await getToken();
			if (!token) throw new Error("Not authenticated");
			return apiFetch<ContributionDay[]>("/api/dashboard/contribution", token);
		},
	});

	const { data: sessions, isLoading: sessionsLoading } = useQuery({
		queryKey: ["recent-sessions"],
		queryFn: async () => {
			const token = await getToken();
			if (!token) throw new Error("Not authenticated");
			return apiFetch<SessionListItem[]>(`/api/sessions?limit=${RECENT_SESSIONS_LIMIT}`, token);
		},
	});

	const streakLine =
		stats && stats.current_streak > 0
			? `Current streak: ${stats.current_streak} day${stats.current_streak === 1 ? "" : "s"}`
			: null;

	return (
		<div className="space-y-5 px-4 lg:px-6">
			<PageHeader title="Overview" description="Your agent cloud at a glance." />
			<div className="grid gap-4 lg:grid-cols-3">
				{/* Left column — live status + activity */}
				<div className="space-y-4 lg:col-span-2">
					<AgentsCard environments={environments} isLoading={envsLoading} />

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

					<Card>
						<CardHeader className="border-b">
							<CardTitle>Recent sessions</CardTitle>
							<CardDescription>Latest syncs from your agents.</CardDescription>
							<CardAction>
								<Button asChild variant="ghost" size="sm">
									<Link href="/sessions">
										View all
										<ArrowRight />
									</Link>
								</Button>
							</CardAction>
						</CardHeader>
						<CardContent className="p-0">
							{sessionsLoading ? (
								<div className="divide-y">
									{Array.from({ length: 3 }).map((_, i) => (
										<SessionRowSkeleton key={i} />
									))}
								</div>
							) : sessions?.length ? (
								<div className="divide-y">
									{sessions.map((s) => (
										<SessionRow key={s.id} session={s} />
									))}
								</div>
							) : (
								<EmptyState
									className="py-6"
									description={
										<>
											No sessions yet. Run{" "}
											<code className="rounded bg-muted px-1.5 py-0.5 text-xs">clawdi sync up</code>{" "}
											on a connected agent.
										</>
									}
								/>
							)}
						</CardContent>
					</Card>
				</div>

				{/* Right column — inventory, KPIs, and the permanent Add-an-agent panel */}
				<div className="space-y-4">
					<ResourcesCard stats={stats} />
					<ThisWeekCard stats={stats} contribution={contribution} />
					<OnboardingCard />
				</div>
			</div>
		</div>
	);
}
