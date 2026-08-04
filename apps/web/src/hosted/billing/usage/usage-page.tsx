"use client";

import { AlertCircle, RefreshCw } from "lucide-react";
import { useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { EmptyState } from "@/components/empty-state";
import { SettingsPanelHeader } from "@/components/settings/settings-panel-header";
import { SettingsSection } from "@/components/settings-section";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { UsageSkeleton } from "@/hosted/billing/components/state-views";
import type { HostedUsageSummary, ManagedModelCatalogItem } from "@/hosted/billing/contracts";
import { billingErrorNormalizer } from "@/hosted/billing/errors";
import { formatUsdExact } from "@/hosted/billing/format";
import { useManagedModelCatalog, useUsage } from "@/hosted/billing/hooks";
import { useUserAiProviders } from "@/hosted/v2/ai-providers/ai-providers-hooks";
import { ProviderIcon } from "@/hosted/v2/ai-providers/ai-providers-ui";
import {
	MANAGED_PROVIDER_ID,
	modelDisplayName,
	modelOptionsForProvider,
	providerDisplayLabel,
} from "@/hosted/v2/ai-providers/model-binding";
import type { AiProvider } from "@/hosted/v2/ai-providers/types";
import { formatShortDate } from "@/lib/format";
import { shouldBlockQueryError } from "@/lib/query-state";

const DESCRIPTION = "Clawdi AI usage in USD for the current reporting window across your agents.";
const USAGE_PAGE_CLASS = "flex flex-col gap-8 px-5 sm:px-6 lg:px-8";

type UnavailableUsageSection = HostedUsageSummary["unavailable_sections"][number];

const UNAVAILABLE_USAGE_SECTION_LABELS = {
	totals: "spend and request totals",
	by_model: "the model breakdown",
	by_day: "the daily breakdown",
} satisfies Record<UnavailableUsageSection, string>;

function decimalUsdNumber(value: string): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function decimalUsdIsZero(value: string): boolean {
	return /^[+-]?0+(?:\.0+)?$/.test(value.trim());
}

function readableList(items: readonly string[]): string {
	if (items.length < 2) return items[0] ?? "some usage data";
	if (items.length === 2) return `${items[0]} and ${items[1]}`;
	return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

function unavailableUsageSections(usage: HostedUsageSummary): UnavailableUsageSection[] {
	const sections = new Set(usage.unavailable_sections);
	if (usage.total_usd === null || usage.total_requests === null) sections.add("totals");
	return [...sections];
}

export function UsagePage() {
	const usage = useUsage();
	const providers = useUserAiProviders();
	const managedModelCatalog = useManagedModelCatalog();
	const [manualRetrying, setManualRetrying] = useState(false);
	const retryUsage = async () => {
		if (manualRetrying) return;
		setManualRetrying(true);
		try {
			await usage.refetch();
		} finally {
			setManualRetrying(false);
		}
	};

	if (usage.isLoading) {
		return (
			<div data-hosted="true" className={USAGE_PAGE_CLASS}>
				<SettingsPanelHeader title="Usage" description={DESCRIPTION} />
				<UsageSkeleton />
			</div>
		);
	}

	if (shouldBlockQueryError(usage.error, usage.data) || !usage.data) {
		return (
			<div data-hosted="true" className={USAGE_PAGE_CLASS}>
				<SettingsPanelHeader title="Usage" description={DESCRIPTION} />
				<ApiErrorPanel
					normalizer={billingErrorNormalizer}
					error={usage.error}
					onRetry={() => {
						void retryUsage();
					}}
				/>
			</div>
		);
	}

	return (
		<UsageSummaryView
			usage={usage.data}
			providers={providers.data ?? []}
			managedModels={managedModelCatalog.data?.models ?? []}
			isRetrying={manualRetrying}
			onRetry={() => {
				void retryUsage();
			}}
		/>
	);
}

export function UsageSummaryView({
	usage,
	providers,
	managedModels,
	isRetrying,
	onRetry,
}: {
	usage: HostedUsageSummary;
	providers: readonly AiProvider[];
	managedModels: readonly ManagedModelCatalogItem[];
	isRetrying: boolean;
	onRetry: () => void;
}) {
	const missingSections = unavailableUsageSections(usage);
	const missingSectionSet = new Set(missingSections);
	const totals =
		!missingSectionSet.has("totals") && usage.total_usd !== null && usage.total_requests !== null
			? { usd: usage.total_usd, requests: usage.total_requests }
			: null;

	if (usage.availability === "unavailable") {
		return (
			<div data-hosted="true" className={USAGE_PAGE_CLASS}>
				<SettingsPanelHeader title="Usage" description={DESCRIPTION} />
				<EmptyState
					variant="inset"
					title="We can’t load your usage right now"
					description="The usage provider is temporarily unavailable. No spend or request total is shown because we could not read it."
					action={<UsageRetryButton isRetrying={isRetrying} onRetry={onRetry} />}
					className="py-10 md:p-10"
				/>
			</div>
		);
	}

	const hasDailyBreakdown = usage.by_day.length > 0;
	const firstDailyPoint = usage.by_day[0];
	const lastDailyPoint = usage.by_day[usage.by_day.length - 1];
	const windowLabel = `${formatShortDate(usage.period_start)} – ${formatShortDate(usage.period_end)}`;
	const dailyChartLabel =
		hasDailyBreakdown && firstDailyPoint && lastDailyPoint
			? `Daily USD usage returned for ${formatShortDate(firstDailyPoint.date)} to ${formatShortDate(lastDailyPoint.date)} within the ${windowLabel} reporting window.`
			: undefined;
	const maxDay = Math.max(0, ...usage.by_day.map((day) => decimalUsdNumber(day.amount_usd)));
	const maxModel = Math.max(
		0,
		...usage.by_model.map((model) => decimalUsdNumber(model.amount_usd)),
	);
	const isRealZero =
		usage.availability === "complete" &&
		totals !== null &&
		decimalUsdIsZero(totals.usd) &&
		totals.requests === 0 &&
		usage.by_model.length === 0;

	if (isRealZero) {
		return (
			<div data-hosted="true" className={USAGE_PAGE_CLASS}>
				<SettingsPanelHeader title="Usage" description={DESCRIPTION} />
				<EmptyState
					variant="inset"
					title="No usage yet"
					description="Once your agents start running, Clawdi AI spend shows up here."
					className="py-10 md:p-10"
				/>
			</div>
		);
	}

	return (
		<div data-hosted="true" className={USAGE_PAGE_CLASS}>
			<SettingsPanelHeader
				title="Usage"
				description={
					totals
						? `${windowLabel} reporting window. Totals below are for this window; wallet balance carries over.`
						: `${windowLabel} reporting window. Available usage details for this window are shown below.`
				}
			/>

			{missingSections.length > 0 ? (
				<Alert data-hosted="true">
					<AlertCircle />
					<AlertTitle>Some usage data is unavailable</AlertTitle>
					<AlertDescription className="flex flex-col items-start gap-3">
						<span>
							We couldn’t read{" "}
							{readableList(
								missingSections.map((section) => UNAVAILABLE_USAGE_SECTION_LABELS[section]),
							)}
							. Other usage shown below was read successfully.
						</span>
						<UsageRetryButton isRetrying={isRetrying} onRetry={onRetry} />
					</AlertDescription>
				</Alert>
			) : null}

			{totals ? (
				<section
					data-hosted="true"
					aria-label="Usage summary"
					className="grid overflow-hidden rounded-lg border sm:grid-cols-2 sm:divide-x"
				>
					<div className="space-y-1 p-4 sm:p-5">
						<div className="text-xs font-medium text-muted-foreground">Clawdi AI spend</div>
						<div className="text-3xl font-semibold tracking-tight tabular-nums">
							{formatUsdExact(totals.usd)}
						</div>
					</div>
					<div className="space-y-1 border-t p-4 sm:border-t-0 sm:p-5">
						<div className="text-xs font-medium text-muted-foreground">Requests</div>
						<div className="text-3xl font-semibold tracking-tight tabular-nums">
							{totals.requests.toLocaleString()}
						</div>
					</div>
				</section>
			) : (
				<EmptyState
					variant="inset"
					title="Usage totals unavailable"
					description="Spend and request totals are hidden because they could not be read."
					className="py-6 md:p-6"
				/>
			)}

			<SettingsSection
				headingLevel={3}
				title="Daily usage"
				description="Clawdi AI spend by day in this reporting window."
			>
				{missingSectionSet.has("by_day") ? (
					<EmptyState
						variant="inset"
						title="Daily breakdown unavailable"
						description="No daily values are shown because the breakdown could not be read."
						className="py-4 md:p-4"
					/>
				) : hasDailyBreakdown ? (
					<>
						<div className="flex h-28 items-end gap-1" role="img" aria-label={dailyChartLabel}>
							{usage.by_day.map((day) => (
								<div
									key={day.date}
									title={`${formatShortDate(day.date)}: ${formatUsdExact(day.amount_usd)}`}
									className="flex-1 rounded-t bg-primary/70 transition-colors hover:bg-primary"
									style={{
										height: `${Math.max(2, maxDay > 0 ? (decimalUsdNumber(day.amount_usd) / maxDay) * 100 : 0)}%`,
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
								{usage.by_day.map((day) => (
									<tr key={day.date}>
										<td>{day.date}</td>
										<td>{formatUsdExact(day.amount_usd)}</td>
									</tr>
								))}
							</tbody>
						</table>
					</>
				) : (
					<EmptyState
						variant="inset"
						description="No daily usage in this reporting window"
						className="py-4 md:p-4"
					/>
				)}
			</SettingsSection>

			<SettingsSection
				headingLevel={3}
				title="By model"
				description="Spend and requests grouped by model."
			>
				<div className="divide-y">
					{missingSectionSet.has("by_model") ? (
						<EmptyState
							variant="inset"
							title="Model breakdown unavailable"
							description="No model values are shown because the breakdown could not be read."
							className="py-4 md:p-4"
						/>
					) : usage.by_model.length === 0 ? (
						<EmptyState
							variant="inset"
							description="No model usage in this reporting window"
							className="py-4 md:p-4"
						/>
					) : (
						usage.by_model.map((model) => {
							const providerId = model.provider ?? MANAGED_PROVIDER_ID;
							const modelName = modelDisplayName(
								model.model,
								modelOptionsForProvider(providerId, providers, managedModels),
							);
							const providerName = providerDisplayLabel(providerId, providers);
							return (
								<div
									key={`${model.provider ?? "managed"}:${model.model}`}
									className="flex min-w-0 items-start gap-2.5 py-3 first:pt-0 last:pb-0"
								>
									<ProviderIcon provider={providerId} providers={providers} size="sm" />
									<div className="min-w-0 flex-1 space-y-1">
										<div className="flex items-baseline justify-between gap-2 text-sm">
											<span className="truncate font-medium">{modelName}</span>
											<span className="shrink-0 tabular-nums">
												{formatUsdExact(model.amount_usd)}
											</span>
										</div>
										<div className="h-2 overflow-hidden rounded-full bg-muted">
											<div
												className="h-2 rounded-full bg-primary"
												style={{
													width: `${maxModel > 0 ? (decimalUsdNumber(model.amount_usd) / maxModel) * 100 : 0}%`,
												}}
											/>
										</div>
										<div className="text-xs text-muted-foreground">
											{providerName} · {model.requests.toLocaleString()} request
											{model.requests === 1 ? "" : "s"}
										</div>
									</div>
								</div>
							);
						})
					)}
				</div>
			</SettingsSection>
		</div>
	);
}

function UsageRetryButton({ isRetrying, onRetry }: { isRetrying: boolean; onRetry: () => void }) {
	return (
		<Button type="button" variant="outline" size="sm" disabled={isRetrying} onClick={onRetry}>
			{isRetrying ? <Spinner className="size-3.5" /> : <RefreshCw className="size-3.5" />}
			Retry
		</Button>
	);
}
