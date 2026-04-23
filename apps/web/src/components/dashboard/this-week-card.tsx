"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { ContributionDay, DashboardStats } from "@/lib/api-schemas";
import { formatNumber } from "@/lib/utils";

function sessionsInLastDays(contribution: ContributionDay[] | undefined, days: number): number {
	if (!contribution) return 0;
	return contribution.slice(-days).reduce((sum, d) => sum + d.count, 0);
}

export function ThisWeekCard({
	stats,
	contribution,
}: {
	stats: DashboardStats | undefined;
	contribution: ContributionDay[] | undefined;
}) {
	const ready = !!stats;
	const weekSessions = sessionsInLastDays(contribution, 7);
	const todaySessions = sessionsInLastDays(contribution, 1);
	const topModel = stats?.favorite_model ? stats.favorite_model.replace("claude-", "") : null;

	return (
		<Card>
			<CardHeader>
				<CardTitle>This week</CardTitle>
				<CardDescription>Last 7 days of agent activity.</CardDescription>
			</CardHeader>
			<CardContent className="space-y-5">
				{/* Hero — sessions this week. The single number users scan first. */}
				<div>
					<div className="text-xs text-muted-foreground">Sessions</div>
					{ready ? (
						<div className="text-3xl font-semibold tabular-nums leading-none">
							{formatNumber(weekSessions)}
						</div>
					) : (
						<Skeleton className="h-9 w-16" />
					)}
				</div>

				{/* Secondary stats — smaller, grouped. */}
				<dl className="grid grid-cols-3 gap-3 text-sm">
					<SecondaryStat label="Today" value={ready ? formatNumber(todaySessions) : null} />
					<SecondaryStat label="Streak" value={ready ? `${stats.current_streak}d` : null} />
					<SecondaryStat label="Top model" value={ready ? (topModel ?? "—") : null} small />
				</dl>
			</CardContent>
		</Card>
	);
}

function SecondaryStat({
	label,
	value,
	small,
}: {
	label: string;
	value: string | null;
	small?: boolean;
}) {
	return (
		<div className="space-y-1">
			<dt className="text-xs text-muted-foreground">{label}</dt>
			{value === null ? (
				<Skeleton className="h-5 w-10" />
			) : (
				<dd
					className={
						small ? "truncate text-sm font-medium" : "text-base font-semibold tabular-nums"
					}
				>
					{value}
				</dd>
			)}
		</div>
	);
}
