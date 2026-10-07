"use client";

import { billingPageClass, usagePageClasses as styles } from "@clawdi/shared/ui";
import {
	type AgentTile,
	completeDailyBreakdown,
	usageCopy as copy,
	dailySpendLabel,
	dailyUsageTotals,
	formatUsageDate,
	sortModelBreakdown,
	USAGE_RANGE_ITEMS,
	type UsageAgentBreakdown,
	type UsageDayBreakdown,
	type UsageRangeDays,
	unavailableUsageSections,
	usageAgentOptions,
	usageAgentText,
	usageRangeDays,
	usageRetrySection,
	usageWindowLabel,
} from "@clawdi/shared/view";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { AgentInline } from "@/components/dashboard/agent-label";
import { EmptyState } from "@/components/empty-state";
import { SettingsPanelHeader } from "@/components/settings/settings-panel-header";
import { SettingsSection } from "@/components/settings-section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { UsageSkeleton } from "@/hosted/billing/components/state-views";
import type { HostedUsageSummary, ManagedModelCatalogItem } from "@/hosted/billing/contracts";
import { billingErrorNormalizer } from "@/hosted/billing/errors";
import { compareDecimals, decimalRatioPercent, formatUsdExact } from "@/hosted/billing/format";
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
import { shouldBlockQueryError } from "@/lib/query-state";

const USAGE_PAGE_CLASS = billingPageClass;

type UsageRangeSelection = {
	days: UsageRangeDays;
	onChange: (days: UsageRangeDays) => void;
};
type AgentBreakdown = UsageAgentBreakdown;
type DayBreakdown = UsageDayBreakdown;

function UsageFilters({
	agents,
	agentTiles,
	selectedAgentId,
	onAgentChange,
	range,
}: {
	agents: readonly AgentBreakdown[];
	agentTiles: readonly AgentTile[];
	selectedAgentId: string;
	onAgentChange: (agentId: string) => void;
	range: UsageRangeSelection;
}) {
	const selectableAgents = usageAgentOptions(agents, agentTiles);
	const agentItems = [
		{ label: copy.allAgents, value: "all" },
		...selectableAgents.map((agent) => ({
			label: usageAgentText(agent.identity),
			value: agent.id,
		})),
	];

	return (
		<>
			<Select
				items={agentItems}
				value={selectedAgentId}
				onValueChange={(value) => onAgentChange(value ?? "all")}
			>
				<SelectTrigger aria-label={copy.agent} className={styles.agentFilter}>
					<SelectValue />
				</SelectTrigger>
				<SelectContent align="end">
					<SelectItem value="all">{copy.allAgents}</SelectItem>
					{selectableAgents.map((agent) => {
						return (
							<SelectItem key={agent.id} value={agent.id}>
								<div className={styles.agentOption}>
									<AgentInline
										name={agent.identity.name}
										displayName={agent.identity.displayName}
										defaultName={agent.identity.defaultName}
										machineName={agent.identity.machineName}
										type={agent.identity.type}
										className="min-w-0"
									/>
									{agent.deleted ? <Badge variant="outline">{copy.deleted}</Badge> : null}
								</div>
							</SelectItem>
						);
					})}
				</SelectContent>
			</Select>
			<Select
				items={USAGE_RANGE_ITEMS}
				value={String(range.days)}
				onValueChange={(value) => range.onChange(usageRangeDays(value))}
			>
				<SelectTrigger aria-label={copy.timeRange} className={styles.rangeFilter}>
					<SelectValue />
				</SelectTrigger>
				<SelectContent align="end">
					{USAGE_RANGE_ITEMS.map((item) => (
						<SelectItem key={item.value} value={item.value}>
							{item.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</>
	);
}

export function UsagePage({ agentTiles }: { agentTiles: readonly AgentTile[] }) {
	const [rangeDays, setRangeDays] = useState<UsageRangeDays>(7);
	const [selectedAgentId, setSelectedAgentId] = useState("all");
	const allUsage = useUsage(rangeDays);
	const scopedUsage = useUsage(rangeDays, selectedAgentId === "all" ? null : selectedAgentId, {
		enabled: selectedAgentId !== "all",
	});
	const usage = selectedAgentId === "all" ? allUsage : scopedUsage;
	const providers = useUserAiProviders();
	const managedModelCatalog = useManagedModelCatalog();
	const [manualRetrying, setManualRetrying] = useState(false);
	const agentOptions = Array.isArray(allUsage.data?.by_agent) ? allUsage.data.by_agent : [];
	const rangeSelection = {
		days: rangeDays,
		onChange: setRangeDays,
	};
	const filters = (
		<UsageFilters
			agents={agentOptions}
			agentTiles={agentTiles}
			selectedAgentId={selectedAgentId}
			onAgentChange={setSelectedAgentId}
			range={rangeSelection}
		/>
	);
	const retryUsage = async () => {
		if (manualRetrying) return;
		setManualRetrying(true);
		try {
			await Promise.all([
				allUsage.refetch(),
				selectedAgentId === "all" ? Promise.resolve() : scopedUsage.refetch(),
			]);
		} finally {
			setManualRetrying(false);
		}
	};

	if (allUsage.isLoading || (selectedAgentId !== "all" && scopedUsage.isLoading)) {
		return (
			<div data-hosted="true" className={USAGE_PAGE_CLASS}>
				<SettingsPanelHeader
					title={copy.title}
					description={
						// Same text length as the loaded date window, so the header keeps its size.
						<span className="animate-pulse rounded-md bg-muted text-transparent">
							Jan 1, 2026 – Jan 31, 2026 · UTC
						</span>
					}
					actions={filters}
				/>
				<UsageSkeleton />
			</div>
		);
	}

	if (shouldBlockQueryError(usage.error, usage.data) || !usage.data) {
		return (
			<div data-hosted="true" className={USAGE_PAGE_CLASS}>
				<SettingsPanelHeader title={copy.title} actions={filters} />
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
			agentOptions={agentOptions}
			agentTiles={agentTiles}
			providers={providers.data ?? []}
			managedModels={managedModelCatalog.data?.models ?? []}
			rangeSelection={rangeSelection}
			selectedAgentId={selectedAgentId}
			onAgentChange={setSelectedAgentId}
			isRetrying={manualRetrying}
			onRetry={() => {
				void retryUsage();
			}}
		/>
	);
}

export function UsageSummaryView({
	usage,
	agentOptions = [],
	agentTiles = [],
	providers,
	managedModels,
	rangeSelection,
	selectedAgentId = "all",
	onAgentChange = () => undefined,
	isRetrying,
	onRetry,
}: {
	usage: HostedUsageSummary;
	agentOptions?: readonly AgentBreakdown[];
	agentTiles?: readonly AgentTile[];
	providers: readonly AiProvider[];
	managedModels: readonly ManagedModelCatalogItem[];
	rangeSelection?: UsageRangeSelection;
	selectedAgentId?: string;
	onAgentChange?: (agentId: string) => void;
	isRetrying: boolean;
	onRetry: () => void;
}) {
	const missingSections = unavailableUsageSections(usage);
	const totals =
		!missingSections.has("totals") && usage.total_usd !== null && usage.total_requests !== null
			? { usd: usage.total_usd, requests: usage.total_requests }
			: null;
	const sortedDays = completeDailyBreakdown(usage.by_day, usage.period_start, usage.period_end);
	const sortedModels = [...usage.by_model].sort(sortModelBreakdown);
	const modelsTruncated = (usage.truncated_sections ?? []).includes("by_model");
	const windowLabel = usageWindowLabel(usage);
	const filters = rangeSelection ? (
		<UsageFilters
			agents={agentOptions}
			agentTiles={agentTiles}
			selectedAgentId={selectedAgentId}
			onAgentChange={onAgentChange}
			range={rangeSelection}
		/>
	) : null;

	if (
		missingSections.has("totals") &&
		missingSections.has("by_model") &&
		missingSections.has("by_day")
	) {
		return (
			<div data-hosted="true" className={USAGE_PAGE_CLASS}>
				<SettingsPanelHeader title={copy.title} description={windowLabel} actions={filters} />
				<EmptyState
					variant="inset"
					title={copy.usageUnavailable}
					action={<UsageRetryButton isRetrying={isRetrying} onRetry={onRetry} />}
					className={styles.pageEmpty}
				/>
			</div>
		);
	}

	const retrySection = usageRetrySection(missingSections);
	const retryAction = (section: typeof retrySection) =>
		retrySection === section ? (
			<UsageRetryButton isRetrying={isRetrying} onRetry={onRetry} />
		) : null;

	return (
		<div data-hosted="true" className={USAGE_PAGE_CLASS}>
			<SettingsPanelHeader title={copy.title} description={windowLabel} actions={filters} />

			{totals ? (
				<section data-hosted="true" aria-label={copy.summary} className={styles.summary}>
					<div className={styles.summaryCell}>
						<div className={styles.summaryLabel}>{copy.spend}</div>
						<div className={styles.summaryValue}>{formatUsdExact(totals.usd)}</div>
					</div>
					<div className={styles.summaryCellNext}>
						<div className={styles.summaryLabel}>{copy.requests}</div>
						<div className={styles.summaryValue}>{totals.requests.toLocaleString()}</div>
					</div>
				</section>
			) : (
				<EmptyState
					variant="inset"
					title={copy.totalsUnavailable}
					action={retryAction("totals")}
					className={styles.totalsEmpty}
				/>
			)}

			<SettingsSection headingLevel={3} title={copy.spendOverTime}>
				{missingSections.has("by_day") ? (
					<EmptyState
						variant="inset"
						title={copy.trendUnavailable}
						action={retryAction("by_day")}
						className={styles.sectionEmpty}
					/>
				) : sortedDays.length === 0 ? (
					<EmptyState variant="inset" title={copy.noUsage} className={styles.sectionEmpty} />
				) : (
					<DailyUsageChart days={sortedDays} />
				)}
			</SettingsSection>

			<SettingsSection
				headingLevel={3}
				title={copy.models}
				description={
					modelsTruncated
						? copy.modelsTruncated.replace("{limit}", String(usage.breakdown_limit))
						: undefined
				}
			>
				{missingSections.has("by_model") ? (
					<EmptyState
						variant="inset"
						title={copy.modelsUnavailable}
						action={retryAction("by_model")}
						className={styles.sectionEmpty}
					/>
				) : sortedModels.length === 0 ? (
					<EmptyState variant="inset" title={copy.noUsage} className={styles.sectionEmpty} />
				) : (
					<table className={styles.table}>
						<caption className="sr-only">{copy.usageByModel}</caption>
						<colgroup>
							<col />
							<col className={styles.numericColumn} />
							<col className={styles.numericColumn} />
						</colgroup>
						<thead>
							<tr className={styles.headRow}>
								<th scope="col" className={styles.headCell}>
									{copy.model}
								</th>
								<th scope="col" className={styles.headNumericCell}>
									{copy.requests}
								</th>
								<th scope="col" className={styles.headNumericCell}>
									{copy.spend}
								</th>
							</tr>
						</thead>
						<tbody className={styles.body}>
							{sortedModels.map((model) => {
								const providerId = model.provider ?? MANAGED_PROVIDER_ID;
								const modelName = modelDisplayName(
									model.model,
									modelOptionsForProvider(providerId, providers, managedModels),
								);
								return (
									<tr key={`${model.provider ?? "managed"}:${model.model}`}>
										<td className={styles.modelCell}>
											<div className={styles.modelIdentity}>
												<ProviderIcon provider={providerId} providers={providers} size="sm" />
												<div className={styles.modelCopy}>
													<div className={styles.modelName}>{modelName}</div>
													<div className={styles.modelProvider}>
														{providerDisplayLabel(providerId, providers)}
													</div>
												</div>
											</div>
										</td>
										<td className={styles.requestsCell}>{model.requests.toLocaleString()}</td>
										<td className={styles.spendCell}>{formatUsdExact(model.amount_usd)}</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				)}
			</SettingsSection>
		</div>
	);
}

function DailyUsageChart({ days }: { days: readonly DayBreakdown[] }) {
	const { peak: maxAmount, total: totalAmount } = dailyUsageTotals(days);
	const firstDay = days[0];
	const lastDay = days.at(-1);

	return (
		<div role="img" aria-label={dailySpendLabel(days, formatUsdExact(totalAmount))}>
			<div className={styles.chartPeakRow}>
				<span className={styles.chartPeak}>
					{copy.peak} {formatUsdExact(maxAmount)}
				</span>
			</div>
			<div className={styles.chartBars} aria-hidden="true">
				{days.map((day) => {
					const amount = day.amount_usd;
					const positive = compareDecimals(amount, "0") === 1;
					const height = decimalRatioPercent(amount, maxAmount);
					const label = `${formatUsageDate(day.date)} · ${formatUsdExact(day.amount_usd)}`;
					return (
						<div key={day.date} className={styles.chartColumn} title={label}>
							<div
								className={positive ? styles.chartBar : styles.chartBarEmpty}
								style={positive ? { height: `${height}%`, minHeight: "2px" } : undefined}
							/>
						</div>
					);
				})}
			</div>
			<div className={styles.chartAxis}>
				<span>{firstDay ? formatUsageDate(firstDay.date) : null}</span>
				{lastDay && lastDay.date !== firstDay?.date ? (
					<span>{formatUsageDate(lastDay.date)}</span>
				) : null}
			</div>
		</div>
	);
}

function UsageRetryButton({ isRetrying, onRetry }: { isRetrying: boolean; onRetry: () => void }) {
	return (
		<Button type="button" variant="outline" size="sm" onClick={onRetry} disabled={isRetrying}>
			{isRetrying ? <Spinner className="size-4" /> : <RefreshCw className="size-4" />}
			{copy.retry}
		</Button>
	);
}
