"use client";

import { thisWeekCardClasses } from "@clawdi/shared/ui";

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
			<CardContent className={thisWeekCardClasses.content}>
				{error ? (
					<ApiErrorPanel error={error} onRetry={onRetry} title={DASHBOARD_COPY.weeklyError} />
				) : (
					<>
						{/* Hero — the user's own sessions. Fleet automation is the quiet
				    sub-line, not the headline. */}
						<div>
							<div className={thisWeekCardClasses.statLabel}>{DASHBOARD_COPY.yourSessions}</div>
							{ready && manualWeek !== undefined ? (
								<>
									<div className={thisWeekCardClasses.sessionCount}>{formatNumber(manualWeek)}</div>
									{automatedWeek !== undefined && automatedWeek > 0 ? (
										<div className={thisWeekCardClasses.automatedCount}>
											+ {formatNumber(automatedWeek)} automated (cron, heartbeat)
										</div>
									) : null}
								</>
							) : (
								<Skeleton className={thisWeekCardClasses.sessionCountSkeleton} />
							)}
						</div>

						{/* Secondary stats — smaller, grouped. */}
						<dl className={thisWeekCardClasses.secondaryStats}>
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
		<div className={thisWeekCardClasses.stat}>
			<dt className={thisWeekCardClasses.statLabel}>{label}</dt>
			{value === null ? (
				<Skeleton
					className={
						small ? thisWeekCardClasses.textValueSkeleton : thisWeekCardClasses.numericValueSkeleton
					}
				/>
			) : (
				<dd className={small ? thisWeekCardClasses.textValue : thisWeekCardClasses.numericValue}>
					{value}
				</dd>
			)}
		</div>
	);
}
