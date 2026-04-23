"use client";

import { useAuth } from "@clerk/nextjs";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, MessageSquare, Zap } from "lucide-react";
import Link from "next/link";
import { ContributionGraph } from "@/components/dashboard/contribution-graph";
import { OnboardingCard } from "@/components/dashboard/onboarding-card";
import { SectionCards } from "@/components/dashboard/section-cards";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
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
import { formatSessionSummary, relativeTime } from "@/lib/utils";

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
									<div key={i} className="flex items-center justify-between gap-4 px-6 py-4">
										<div className="min-w-0 flex-1 space-y-2">
											<Skeleton className="h-4 w-64" />
											<Skeleton className="h-3 w-48" />
										</div>
										<Skeleton className="h-3 w-16" />
									</div>
								))}
							</div>
						) : sessions?.length ? (
							<div className="divide-y">
								{sessions.map((s) => (
									<Link
										key={s.id}
										href={`/sessions/${s.id}`}
										className="flex items-center justify-between gap-4 px-6 py-4 transition-colors hover:bg-accent/50"
									>
										<div className="min-w-0 flex-1">
											<div className="truncate text-sm font-medium">
												{formatSessionSummary(s.summary) || s.local_session_id.slice(0, 8)}
											</div>
											<div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
												{s.agent_type ? (
													<Badge variant="outline" className="font-normal">
														{s.agent_type === "claude_code"
															? "Claude Code"
															: s.agent_type === "hermes"
																? "Hermes"
																: s.agent_type}
													</Badge>
												) : null}
												<span className="truncate">
													{s.project_path?.split("/").pop() ?? "no project"}
												</span>
												{s.model ? (
													<span className="truncate">{s.model.replace("claude-", "")}</span>
												) : null}
												<span className="flex items-center gap-1">
													<MessageSquare className="size-3" />
													{s.message_count}
												</span>
												<span className="flex items-center gap-1">
													<Zap className="size-3" />
													{((s.input_tokens + s.output_tokens) / 1000).toFixed(1)}k
												</span>
											</div>
										</div>
										<span className="shrink-0 text-xs text-muted-foreground">
											{relativeTime(s.started_at)}
										</span>
									</Link>
								))}
							</div>
						) : (
							<EmptyState
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
