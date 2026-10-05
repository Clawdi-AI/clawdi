"use client";

import { DASHBOARD_COPY, formatNumber, thisWeekModel } from "@clawdi/shared/view";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { DashboardStats } from "@/lib/api-schemas";

export function ThisWeekCard({
	stats,
	error,
	onRetry,
}: {
	stats: DashboardStats | undefined;
	error?: unknown;
	onRetry?: () => void;
}) {
	const { ready, todaySessions, topModel, manualWeek, automatedWeek, streakLabel } =
		thisWeekModel(stats);

	return (
		<Card>
			<CardHeader>
				<CardTitle>{DASHBOARD_COPY.weeklyTitle}</CardTitle>
				<CardDescription>{DASHBOARD_COPY.weeklyDescription}</CardDescription>
			</CardHeader>
			<CardContent className="space-y-5">
				{error ? (
					<ApiErrorPanel error={error} onRetry={onRetry} title={DASHBOARD_COPY.weeklyError} />
				) : (
					<>
						{/* Hero — the user's own sessions. Fleet automation is the quiet
				    sub-line, not the headline. */}
						<div>
							<div className="text-xs text-muted-foreground">{DASHBOARD_COPY.yourSessions}</div>
							{ready && manualWeek !== undefined ? (
								<>
									<div className="text-3xl font-semibold tabular-nums leading-none">
										{formatNumber(manualWeek)}
									</div>
									{automatedWeek !== undefined && automatedWeek > 0 ? (
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
							<SecondaryStat
								label={DASHBOARD_COPY.today}
								value={ready && todaySessions !== undefined ? formatNumber(todaySessions) : null}
							/>
							<SecondaryStat label={DASHBOARD_COPY.streak} value={streakLabel} />
							<SecondaryStat
								label={DASHBOARD_COPY.topModel}
								value={ready ? (topModel ?? "—") : null}
								small
							/>
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
