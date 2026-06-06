"use client";

import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { unwrap, useApi } from "@/lib/api";
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
}: {
	stats: DashboardStats | undefined;
	contribution: ContributionDay[] | undefined;
}) {
	const api = useApi();
	const ready = !!stats;
	const weekSessions = sessionsInLastDays(contribution, 7);
	const todaySessions = sessionsInLastDays(contribution, 1);
	const topModel = formatModelLabel(stats?.favorite_model) || null;

	// "388 sessions this week" is a fleet vanity number when ~3/4 of it
	// is cron/heartbeat ticks. Split out the user's own (manual) count —
	// that's the number that means anything. One cheap count query:
	// page_size=1, we only read `total`.
	const { data: manualWeek } = useQuery({
		queryKey: ["this-week-manual"],
		queryFn: async () => {
			const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
			const page = unwrap(
				await api.GET("/api/sessions", {
					params: { query: { page_size: 1, automated: false, since } },
				}),
			);
			return page.total;
		},
	});
	const automatedWeek = manualWeek === undefined ? null : Math.max(0, weekSessions - manualWeek);

	return (
		<Card>
			<CardHeader>
				<CardTitle>This week</CardTitle>
				<CardDescription>Last 7 days of agent activity.</CardDescription>
			</CardHeader>
			<CardContent className="space-y-5">
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
