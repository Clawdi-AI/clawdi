"use client";

import type { DeployComponents } from "@clawdi/shared/api";
import { Activity, RefreshCw, TriangleAlert } from "lucide-react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { UsageSkeleton } from "@/hosted/billing/components/state-views";
import { billingErrorNormalizer } from "@/hosted/billing/errors";
import { formatUsdExact } from "@/hosted/billing/format";
import { useManagedModelCatalog, useUsage } from "@/hosted/billing/hooks";
import { useUserAiProviders } from "@/hosted/v2/ai-providers/ai-providers-hooks";
import {
	MANAGED_PROVIDER_ID,
	modelDisplayName,
	modelOptionsForProvider,
	providerDisplayLabel,
} from "@/hosted/v2/ai-providers/model-binding";
import { formatShortDate } from "@/lib/format";
import { cn } from "@/lib/utils";

const DESCRIPTION = "Managed-AI usage in USD for the current reporting window across your agents.";
const USAGE_PAGE_CLASS = cn(CENTERED_PAGE_WIDTH_CLASS.page, "space-y-6 px-4 lg:px-6");
const USAGE_UNAVAILABLE_ERROR = new Error(
	"Usage data is temporarily unavailable. No usage totals were shown.",
);

type HostedUsage = DeployComponents["schemas"]["V2HostedUsageSummaryResponse"];
type UsageUnavailableSection = HostedUsage["unavailable_sections"][number];

export type UsagePageState =
	| { kind: "unavailable" }
	| { kind: "empty" }
	| { kind: "partial"; description: string }
	| { kind: "complete" };

export function partialUsageDescription(sections: readonly UsageUnavailableSection[]): string {
	const totalsUnavailable = sections.includes("totals");
	const modelsUnavailable = sections.includes("by_model");
	const dailyUnavailable = sections.includes("by_day");
	if (totalsUnavailable && modelsUnavailable && !dailyUnavailable) {
		return "Usage totals and the model breakdown are temporarily unavailable. Only the daily breakdown could be loaded.";
	}
	if (dailyUnavailable && !totalsUnavailable && !modelsUnavailable) {
		return "The daily breakdown is temporarily unavailable. The totals and model breakdown below are complete.";
	}
	return "Some usage data is temporarily unavailable. Missing sections are labelled below.";
}

export function usagePageState(usage: HostedUsage): UsagePageState {
	if (usage.availability === "unavailable") return { kind: "unavailable" };
	if (usage.availability === "partial") {
		return {
			kind: "partial",
			description: partialUsageDescription(usage.unavailable_sections),
		};
	}
	if (usage.total_usd === null || usage.total_requests === null) {
		return { kind: "unavailable" };
	}
	if (decimalUsdNumber(usage.total_usd) === 0 && usage.by_model.length === 0) {
		return { kind: "empty" };
	}
	return { kind: "complete" };
}

function decimalUsdNumber(value: string): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export function UsagePage() {
	const usage = useUsage();
	const providers = useUserAiProviders();
	const managedModelCatalog = useManagedModelCatalog();

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
	const pageState = usagePageState(u);
	if (pageState.kind === "unavailable") {
		return (
			<div data-hosted="true" className={USAGE_PAGE_CLASS}>
				<PageHeader title="Usage" description={DESCRIPTION} />
				<ApiErrorPanel
					normalizer={billingErrorNormalizer}
					error={USAGE_UNAVAILABLE_ERROR}
					title="Couldn't load usage"
					onRetry={() => usage.refetch()}
				/>
			</div>
		);
	}

	const hasDailyBreakdown = u.by_day.length > 0;
	const totalsUnavailable = u.total_usd === null || u.total_requests === null;
	const dailyUnavailable = u.unavailable_sections.includes("by_day");
	const modelsUnavailable = u.unavailable_sections.includes("by_model");
	const firstDailyPoint = u.by_day[0];
	const lastDailyPoint = u.by_day[u.by_day.length - 1];
	const windowLabel = `${formatShortDate(u.period_start)} – ${formatShortDate(u.period_end)}`;
	const dailyChartLabel =
		hasDailyBreakdown && firstDailyPoint && lastDailyPoint
			? `Daily USD usage returned for ${formatShortDate(firstDailyPoint.date)} to ${formatShortDate(lastDailyPoint.date)} within the ${windowLabel} reporting window.`
			: undefined;
	const maxDay = Math.max(0, ...u.by_day.map((day) => decimalUsdNumber(day.amount_usd)));
	const maxModel = Math.max(0, ...u.by_model.map((model) => decimalUsdNumber(model.amount_usd)));

	if (pageState.kind === "empty") {
		return (
			<div data-hosted="true" className={USAGE_PAGE_CLASS}>
				<PageHeader title="Usage" description={DESCRIPTION} />
				<EmptyState
					icon={Activity}
					title="No usage yet"
					description="Once your agents start running, managed-AI spend shows up here."
				/>
			</div>
		);
	}

	return (
		<div data-hosted="true" className={USAGE_PAGE_CLASS}>
			<PageHeader
				title="Usage"
				description={
					pageState.kind === "partial"
						? `${windowLabel} reporting window. Available data is shown below; missing sections are labelled.`
						: `${windowLabel} reporting window. Totals below are for this window; wallet balance carries over.`
				}
			/>

			{pageState.kind === "partial" ? (
				<Alert>
					<TriangleAlert aria-hidden />
					<AlertTitle>Some usage data couldn't be loaded</AlertTitle>
					<AlertDescription className="flex flex-col items-start gap-3">
						<span>{pageState.description}</span>
						<Button type="button" size="sm" variant="outline" onClick={() => usage.refetch()}>
							<RefreshCw /> Retry
						</Button>
					</AlertDescription>
				</Alert>
			) : null}

			{/* Totals */}
			<div className="grid gap-3 sm:grid-cols-2">
				<Card data-hosted="true">
					<CardContent>
						<div className="text-3xl font-semibold tabular-nums">
							{u.total_usd === null ? "Unavailable" : formatUsdExact(u.total_usd)}
						</div>
						<div className="text-sm text-muted-foreground">Managed-AI spend in window</div>
					</CardContent>
				</Card>
				<Card data-hosted="true">
					<CardContent>
						<div className="text-3xl font-semibold tabular-nums">
							{u.total_requests === null ? "Unavailable" : u.total_requests.toLocaleString()}
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
					{dailyUnavailable ? (
						<EmptyState
							variant="inset"
							description="Daily breakdown temporarily unavailable"
							className="py-4 md:p-4"
						/>
					) : hasDailyBreakdown ? (
						<>
							<div className="flex h-28 items-end gap-1" role="img" aria-label={dailyChartLabel}>
								{u.by_day.map((d) => (
									<div
										key={d.date}
										title={`${formatShortDate(d.date)}: ${formatUsdExact(d.amount_usd)}`}
										className="flex-1 rounded-t bg-primary/70 transition-colors hover:bg-primary"
										style={{
											height: `${Math.max(
												2,
												maxDay > 0 ? (decimalUsdNumber(d.amount_usd) / maxDay) * 100 : 0,
											)}%`,
										}}
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
										<th scope="col">USD used</th>
									</tr>
								</thead>
								<tbody>
									{u.by_day.map((d) => (
										<tr key={d.date}>
											<td>{d.date}</td>
											<td>{formatUsdExact(d.amount_usd)}</td>
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
					{modelsUnavailable || totalsUnavailable ? (
						<EmptyState
							variant="inset"
							description="Model breakdown temporarily unavailable"
							className="py-4 md:p-4"
						/>
					) : u.by_model.length === 0 ? (
						<EmptyState
							variant="inset"
							description="No model breakdown available"
							className="py-4 md:p-4"
						/>
					) : (
						u.by_model.map((m) => {
							const providerId = m.provider ?? MANAGED_PROVIDER_ID;
							const modelName = modelDisplayName(
								m.model,
								modelOptionsForProvider(
									providerId,
									providers.data ?? [],
									managedModelCatalog.data?.models ?? [],
								),
							);
							const providerName = providerDisplayLabel(providerId, providers.data);
							return (
								<div key={`${m.provider ?? "managed"}:${m.model}`} className="space-y-1">
									<div className="flex items-baseline justify-between gap-2 text-sm">
										<span className="truncate font-medium">{modelName}</span>
										<span className="shrink-0 tabular-nums">{formatUsdExact(m.amount_usd)}</span>
									</div>
									<div className="h-2 overflow-hidden rounded-full bg-muted">
										<div
											className="h-2 rounded-full bg-primary"
											style={{
												width: `${maxModel > 0 ? (decimalUsdNumber(m.amount_usd) / maxModel) * 100 : 0}%`,
											}}
										/>
									</div>
									<div className="text-xs text-muted-foreground">
										{providerName} · {m.requests.toLocaleString()} request
										{m.requests === 1 ? "" : "s"}
									</div>
								</div>
							);
						})
					)}
				</CardContent>
			</Card>
		</div>
	);
}
