"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
	const weekSessions = sessionsInLastDays(contribution, 7);
	const todaySessions = sessionsInLastDays(contribution, 1);

	return (
		<Card>
			<CardHeader>
				<CardTitle>This week</CardTitle>
			</CardHeader>
			<CardContent className="grid grid-cols-2 gap-4">
				<Stat label="Sessions" value={stats ? formatNumber(weekSessions) : null} />
				<Stat label="Today" value={stats ? formatNumber(todaySessions) : null} />
				<Stat
					label="Streak"
					value={stats ? `${stats.current_streak}d` : null}
					hint={
						stats && stats.longest_streak > stats.current_streak
							? `Best ${stats.longest_streak}d`
							: undefined
					}
				/>
				<Stat
					label="Top model"
					value={stats?.favorite_model ? stats.favorite_model.replace("claude-", "") : "—"}
					small
				/>
			</CardContent>
		</Card>
	);
}

function Stat({
	label,
	value,
	hint,
	small,
}: {
	label: string;
	value: string | null;
	hint?: string;
	small?: boolean;
}) {
	return (
		<div className="space-y-1">
			<div className="text-xs text-muted-foreground">{label}</div>
			{value === null ? (
				<Skeleton className="h-7 w-12" />
			) : (
				<div className={small ? "text-sm font-medium" : "text-xl font-semibold tabular-nums"}>
					{value}
				</div>
			)}
			{hint ? <div className="text-xs text-muted-foreground">{hint}</div> : null}
		</div>
	);
}
