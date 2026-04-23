"use client";

import { useAuth } from "@clerk/nextjs";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { ContributionGraph } from "@/components/dashboard/contribution-graph";
import { OnboardingCard } from "@/components/dashboard/onboarding-card";
import { SectionCards } from "@/components/dashboard/section-cards";
import { EmptyState } from "@/components/empty-state";
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
import type { ContributionDay, DashboardStats, SessionListItem } from "@/lib/api-schemas";

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
			return apiFetch<SessionListItem[]>("/api/sessions?limit=8", token);
		},
	});

	const isNewUser =
		stats &&
		stats.total_sessions === 0 &&
		(stats.memories_count ?? 0) === 0 &&
		(stats.skills_count ?? 0) === 0;

	return (
		<>
			{/* Stat cards — dashboard-01 SectionCards pattern */}
			<SectionCards stats={stats} />

			{/* Onboarding only for truly empty accounts */}
			{isNewUser ? (
				<div className="px-4 lg:px-6">
					<OnboardingCard />
				</div>
			) : null}

			{/* Activity — full-width heatmap, needs 53 columns of breathing room */}
			<div className="px-4 lg:px-6">
				<Card>
					<CardHeader>
						<CardTitle>Activity</CardTitle>
						<CardDescription>Sessions per day in the last 12 months.</CardDescription>
					</CardHeader>
					<CardContent>
						{contribLoading ? (
							<Skeleton className="h-28 w-full rounded-md" />
						) : contribution ? (
							<ContributionGraph data={contribution} />
						) : null}
					</CardContent>
				</Card>
			</div>

			{/* Recent sessions — full-width, rich rows */}
			<div className="px-4 lg:px-6">
				<Card>
					<CardHeader className="border-b">
						<CardTitle>Recent sessions</CardTitle>
						<CardDescription>Latest agent syncs.</CardDescription>
						<CardAction>
							<Button asChild variant="ghost" size="sm">
								<Link href="/sessions">
									View all
									<ArrowUpRight />
								</Link>
							</Button>
						</CardAction>
					</CardHeader>
					<CardContent className="p-0">
						{sessionsLoading ? (
							<div className="divide-y">
								{Array.from({ length: 4 }).map((_, i) => (
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
										on a connected agent to populate this list.
									</>
								}
							/>
						)}
					</CardContent>
				</Card>
			</div>
		</>
	);
}
