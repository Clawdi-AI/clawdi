"use client";

import { Activity } from "lucide-react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { UsageSkeleton } from "@/hosted/billing/components/state-views";
import { billingErrorNormalizer } from "@/hosted/billing/errors";
import { formatCredits } from "@/hosted/billing/format";
import { useUsage } from "@/hosted/billing/hooks";
import { formatShortDate } from "@/lib/format";
import { cn } from "@/lib/utils";

const DESCRIPTION = "AI Credits usage for the current reporting window across your agents.";
const USAGE_PAGE_CLASS = cn(CENTERED_PAGE_WIDTH_CLASS.page, "space-y-6 px-4 lg:px-6");

export function UsagePage() {
	const usage = useUsage();

	if (usage.isLoading) {
		return (
			<div data-hosted="true" className={USAGE_PAGE_CLASS}>
				<PageHeader title="Usage" description={DESCRIPTION} />
				<UsageSkeleton />
			</div>
		);
	}

	if (usage.error || !usage.data) {
		return (
			<div data-hosted="true" className={USAGE_PAGE_CLASS}>
				<PageHeader title="Usage" description={DESCRIPTION} />
				<ApiErrorPanel
					normalizer={billingErrorNormalizer}
					error={usage.error}
					onRetry={() => usage.refetch()}
				/>
			</div>
		);
	}

	const u = usage.data;
	const hasDailyBreakdown = u.by_day.length > 0;
	const firstDailyPoint = u.by_day[0];
	const lastDailyPoint = u.by_day[u.by_day.length - 1];
	const windowLabel = `${formatShortDate(u.period_start)} – ${formatShortDate(u.period_end)}`;
	const dailyChartLabel =
		hasDailyBreakdown && firstDailyPoint && lastDailyPoint
			? `Daily AI Credits usage returned for ${formatShortDate(firstDailyPoint.date)} to ${formatShortDate(lastDailyPoint.date)} within the ${windowLabel} reporting window.`
			: undefined;
	const maxDay = Math.max(1, ...u.by_day.map((d) => d.credits));
	const maxModel = Math.max(1, ...u.by_model.map((m) => m.credits));

	if (u.total_credits === 0 && u.by_model.length === 0) {
		return (
			<div data-hosted="true" className={USAGE_PAGE_CLASS}>
				<PageHeader title="Usage" description={DESCRIPTION} />
				<EmptyState
					icon={Activity}
					title="No usage yet"
					description="Once your agents start running, credit consumption shows up here."
				/>
			</div>
		);
	}

	return (
		<div data-hosted="true" className={USAGE_PAGE_CLASS}>
			<PageHeader
				title="Usage"
				description={`${windowLabel} reporting window. Totals below are for this window; wallet balance carries over.`}
			/>

			{/* Totals */}
			<div className="grid gap-3 sm:grid-cols-2">
				<Card data-hosted="true">
					<CardContent>
						<div className="text-3xl font-semibold tabular-nums">
							{formatCredits(u.total_credits)}
						</div>
						<div className="text-sm text-muted-foreground">AI Credits used in window</div>
					</CardContent>
				</Card>
				<Card data-hosted="true">
					<CardContent>
						<div className="text-3xl font-semibold tabular-nums">
							{u.total_requests.toLocaleString()}
						</div>
						<div className="text-sm text-muted-foreground">Requests in window</div>
					</CardContent>
				</Card>
			</div>

			{/* Daily consumption */}
			<Card data-hosted="true">
				<CardHeader>
					<CardTitle className="text-base">Daily consumption</CardTitle>
				</CardHeader>
				<CardContent>
					{hasDailyBreakdown ? (
						<>
							<div className="flex h-28 items-end gap-1" role="img" aria-label={dailyChartLabel}>
								{u.by_day.map((d) => (
									<div
										key={d.date}
										title={`${formatShortDate(d.date)}: ${formatCredits(d.credits)}`}
										className="flex-1 rounded-t bg-primary/70 transition-colors hover:bg-primary"
										style={{ height: `${Math.max(2, (d.credits / maxDay) * 100)}%` }}
									/>
								))}
							</div>
							<div className="mt-1.5 flex justify-between text-2xs text-muted-foreground">
								<span>{formatShortDate(firstDailyPoint?.date, { includeYear: false })}</span>
								<span>{formatShortDate(lastDailyPoint?.date, { includeYear: false })}</span>
							</div>
							<table className="sr-only">
								<caption>Daily consumption by day in the reporting window</caption>
								<thead>
									<tr>
										<th scope="col">Day</th>
										<th scope="col">AI Credits used</th>
									</tr>
								</thead>
								<tbody>
									{u.by_day.map((d) => (
										<tr key={d.date}>
											<td>{d.date}</td>
											<td>{formatCredits(d.credits)}</td>
										</tr>
									))}
								</tbody>
							</table>
						</>
					) : (
						<EmptyState
							variant="inset"
							description="No daily breakdown available"
							className="py-4 md:p-4"
						/>
					)}
				</CardContent>
			</Card>

			{/* By model */}
			<Card data-hosted="true">
				<CardHeader>
					<CardTitle className="text-base">By model</CardTitle>
				</CardHeader>
				<CardContent className="flex flex-col gap-4">
					{u.by_model.length === 0 ? (
						<EmptyState
							variant="inset"
							description="No model breakdown available"
							className="py-4 md:p-4"
						/>
					) : (
						u.by_model.map((m) => (
							<div key={`${m.provider ?? "managed"}:${m.model}`} className="space-y-1">
								<div className="flex items-baseline justify-between gap-2 text-sm">
									<span className="truncate font-medium">{m.model}</span>
									<span className="shrink-0 tabular-nums">{formatCredits(m.credits)}</span>
								</div>
								<div className="h-2 overflow-hidden rounded-full bg-muted">
									<div
										className="h-2 rounded-full bg-primary"
										style={{ width: `${(m.credits / maxModel) * 100}%` }}
									/>
								</div>
								<div className="text-xs text-muted-foreground">
									{m.provider ? `${m.provider} · ` : ""}
									{m.requests.toLocaleString()} requests
								</div>
							</div>
						))
					)}
				</CardContent>
			</Card>
		</div>
	);
}
