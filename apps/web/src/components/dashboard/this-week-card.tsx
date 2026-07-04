"use client";

import { ApiErrorPanel } from "@/components/api-error-panel";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { ContributionDay, DashboardStats } from "@/lib/api-schemas";
import { formatModelLabel } from "@/lib/format";
import { formatNumber } from "@/lib/utils";

function sessionsInLastDays(contribution: ContributionDay[] | undefined, days: number): number {
	if (!contribution) return 0;
	return contribution.slice(-days).reduce((sum, d) => sum + d.count, 0);
}

export function ThisWeekCard({
	stats,
	contribution,
	error,
	onRetry,
}: {
	stats: DashboardStats | undefined;
	contribution: ContributionDay[] | undefined;
	error?: unknown;
	onRetry?: () => void;
}) {
	const ready = !!stats;
	const weekSessions = sessionsInLastDays(contribution, 7);
	const todaySessions = sessionsInLastDays(contribution, 1);
	const topModel = formatModelLabel(stats?.favorite_model) || null;
	const manualWeek = stats?.manual_sessions_last_7_days;
	const automatedWeek = manualWeek === undefined ? null : Math.max(0, weekSessions - manualWeek);

	return (
		<Card>
			<CardHeader>
				<CardTitle>This week</CardTitle>
				<CardDescription>Last 7 days of agent activity.</CardDescription>
			</CardHeader>
			<CardContent className="space-y-5">
				{error ? (
					<ApiErrorPanel error={error} onRetry={onRetry} title="Couldn't load weekly activity" />
				) : (
					<>
						{/* Hero — the user's own sessions. Fleet automation is the quiet
				    sub-line, not the headline. */}
						<div>
							<div className="text-xs text-muted-foreground">Your sessions</div>
							{ready && manualWeek !== undefined ? (
								<>
									<div className="text-3xl font-semibold tabular-nums leading-none">
										{formatNumber(Math.min(manualWeek, weekSessions))}
									</div>
									{automatedWeek !== null && automatedWeek > 0 ? (
										<div className="mt-1 text-xs text-muted-foreground tabular-nums">
											+ {formatNumber(automatedWeek)} automated (cron, heartbeat)
										</div>
									) : null}
								</>
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
					</>
				)}
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
