"use client";

import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { AgentInline, agentIdentity } from "@/components/dashboard/agent-label";
import type { AgentTile } from "@/components/dashboard/agents-card";
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
import { deploymentDisplayName } from "@/hosted/agent-identity";
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

const USAGE_PAGE_CLASS = "flex flex-col gap-8 px-5 sm:px-6 lg:px-8";
const USAGE_RANGE_ITEMS = [
	{ label: "Last 7 days", value: "7" },
	{ label: "Last 30 days", value: "30" },
	{ label: "Last 90 days", value: "90" },
] as const;

type VisibleUsageSection = "totals" | "by_model" | "by_day";
type UsageRangeDays = 7 | 30 | 90;
type UsageRangeSelection = {
	days: UsageRangeDays;
	onChange: (days: UsageRangeDays) => void;
};
type AgentBreakdown = NonNullable<HostedUsageSummary["by_agent"]>[number];
type ModelBreakdown = HostedUsageSummary["by_model"][number];
type DayBreakdown = HostedUsageSummary["by_day"][number];

type UsageAgentIdentity = {
	name: string | null;
	displayName: string | null;
	defaultName: string | null;
	machineName: string | null;
	type: string | null;
};

function compareStableText(left: string, right: string): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}

function decimalUsdParts(value: string): readonly [string, string] {
	const match = /^\+?(\d+)(?:\.(\d+))?$/.exec(value.trim());
	if (!match) return ["0", ""];
	return [(match[1] ?? "0").replace(/^0+(?=\d)/, ""), (match[2] ?? "").replace(/0+$/, "")];
}

function compareSpendDescending(left: string, right: string): number {
	const [leftWhole, leftFraction] = decimalUsdParts(left);
	const [rightWhole, rightFraction] = decimalUsdParts(right);
	if (leftWhole.length !== rightWhole.length) return rightWhole.length - leftWhole.length;
	const wholeOrder = compareStableText(leftWhole, rightWhole);
	if (wholeOrder !== 0) return -wholeOrder;
	const fractionLength = Math.max(leftFraction.length, rightFraction.length);
	return -compareStableText(
		leftFraction.padEnd(fractionLength, "0"),
		rightFraction.padEnd(fractionLength, "0"),
	);
}

function sortAgentBreakdown(left: AgentBreakdown, right: AgentBreakdown): number {
	const spendOrder = compareSpendDescending(left.amount_usd, right.amount_usd);
	if (spendOrder !== 0) return spendOrder;
	const leftName = left.agent_name?.toLowerCase() ?? "\uffff";
	const rightName = right.agent_name?.toLowerCase() ?? "\uffff";
	const nameOrder = compareStableText(leftName, rightName);
	return nameOrder !== 0 ? nameOrder : compareStableText(left.agent_id ?? "", right.agent_id ?? "");
}

function sortModelBreakdown(left: ModelBreakdown, right: ModelBreakdown): number {
	const spendOrder = compareSpendDescending(left.amount_usd, right.amount_usd);
	if (spendOrder !== 0) return spendOrder;
	const modelOrder = compareStableText(left.model.toLowerCase(), right.model.toLowerCase());
	return modelOrder !== 0
		? modelOrder
		: compareStableText(left.provider ?? "", right.provider ?? "");
}

function usageAgentIdentity(
	agent: AgentBreakdown,
	agentTiles: readonly AgentTile[],
): UsageAgentIdentity {
	const tile = agent.agent_id
		? agentTiles.find((candidate) => candidate.id === agent.agent_id)
		: null;
	const env = tile?.env ?? null;
	const fallbackName = agent.agent_name
		? deploymentDisplayName(agent.agent_name, agent.agent_type ?? undefined)
		: null;
	return {
		name: env?.name ?? tile?.name ?? fallbackName,
		displayName: env?.display_name ?? null,
		defaultName: env?.default_name ?? null,
		machineName: env?.machine_name ?? null,
		type: env?.agent_type ?? tile?.agentType ?? agent.agent_type ?? null,
	};
}

function usageAgentText(identity: UsageAgentIdentity): string {
	const label = agentIdentity({
		name: identity.name,
		display_name: identity.displayName,
		default_name: identity.defaultName,
		machine_name: identity.machineName,
		agent_type: identity.type,
	});
	return label.secondaryLabel
		? `${label.primaryLabel} · ${label.secondaryLabel}`
		: label.primaryLabel;
}

function unavailableUsageSections(usage: HostedUsageSummary): Set<VisibleUsageSection> {
	const sections = new Set<VisibleUsageSection>();
	if (
		usage.unavailable_sections.includes("totals") ||
		usage.total_usd === null ||
		usage.total_requests === null
	) {
		sections.add("totals");
	}
	if (usage.unavailable_sections.includes("by_model")) sections.add("by_model");
	if (usage.unavailable_sections.includes("by_day") || !Array.isArray(usage.by_day)) {
		sections.add("by_day");
	}
	return sections;
}

function completeDailyBreakdown(
	days: readonly DayBreakdown[],
	periodStart: string,
	periodEnd: string,
): DayBreakdown[] {
	const start = new Date(`${periodStart.slice(0, 10)}T00:00:00Z`);
	const end = new Date(`${periodEnd.slice(0, 10)}T00:00:00Z`);
	if (Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf()) || start > end) {
		return [...days].sort((left, right) => compareStableText(left.date, right.date));
	}

	const amountByDate = new Map(days.map((day) => [day.date, day.amount_usd]));
	const completed: DayBreakdown[] = [];
	for (let cursor = start, count = 0; cursor <= end && count < 366; count += 1) {
		const date = cursor.toISOString().slice(0, 10);
		completed.push({ date, amount_usd: amountByDate.get(date) ?? "0" });
		cursor = new Date(cursor.valueOf() + 86_400_000);
	}
	return completed;
}

function usageRangeDays(value: string | null): UsageRangeDays {
	switch (value) {
		case "7":
			return 7;
		case "30":
			return 30;
		case "90":
			return 90;
		default:
			return 7;
	}
}

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
	const selectableAgents = [...agents]
		.filter((agent): agent is AgentBreakdown & { agent_id: string } => Boolean(agent.agent_id))
		.sort(sortAgentBreakdown);
	const agentItems = [
		{ label: "All agents", value: "all" },
		...selectableAgents.map((agent) => ({
			label: usageAgentText(usageAgentIdentity(agent, agentTiles)),
			value: agent.agent_id,
		})),
	];

	return (
		<>
			<Select
				items={agentItems}
				value={selectedAgentId}
				onValueChange={(value) => onAgentChange(value ?? "all")}
			>
				<SelectTrigger aria-label="Agent" className="min-w-0 flex-1 sm:w-56 sm:flex-none">
					<SelectValue />
				</SelectTrigger>
				<SelectContent align="end">
					<SelectItem value="all">All agents</SelectItem>
					{selectableAgents.map((agent) => {
						const identity = usageAgentIdentity(agent, agentTiles);
						return (
							<SelectItem key={agent.agent_id} value={agent.agent_id}>
								<div className="flex min-w-0 flex-1 items-center justify-between gap-3">
									<AgentInline
										name={identity.name}
										displayName={identity.displayName}
										defaultName={identity.defaultName}
										machineName={identity.machineName}
										type={identity.type}
										className="min-w-0"
									/>
									{agent.agent_deleted ? <Badge variant="outline">Deleted</Badge> : null}
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
				<SelectTrigger aria-label="Time range" className="min-w-0 flex-1 sm:w-40 sm:flex-none">
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
				<SettingsPanelHeader title="Usage" actions={filters} />
				<UsageSkeleton />
			</div>
		);
	}

	if (shouldBlockQueryError(usage.error, usage.data) || !usage.data) {
		return (
			<div data-hosted="true" className={USAGE_PAGE_CLASS}>
				<SettingsPanelHeader title="Usage" actions={filters} />
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
	const windowLabel = `${formatShortDate(usage.period_start)} – ${formatShortDate(usage.period_end)}`;
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
				<SettingsPanelHeader title="Usage" description={windowLabel} actions={filters} />
				<EmptyState
					variant="inset"
					title="Usage unavailable"
					action={<UsageRetryButton isRetrying={isRetrying} onRetry={onRetry} />}
					className="py-10 md:p-10"
				/>
			</div>
		);
	}

	const retrySection: VisibleUsageSection | null = missingSections.has("totals")
		? "totals"
		: missingSections.has("by_day")
			? "by_day"
			: missingSections.has("by_model")
				? "by_model"
				: null;
	const retryAction = (section: VisibleUsageSection) =>
		retrySection === section ? (
			<UsageRetryButton isRetrying={isRetrying} onRetry={onRetry} />
		) : null;

	return (
		<div data-hosted="true" className={USAGE_PAGE_CLASS}>
			<SettingsPanelHeader title="Usage" description={windowLabel} actions={filters} />

			{totals ? (
				<section
					data-hosted="true"
					aria-label="Usage summary"
					className="grid overflow-hidden rounded-lg border sm:grid-cols-2 sm:divide-x"
				>
					<div className="space-y-1 p-4 sm:p-5">
						<div className="text-xs font-medium text-muted-foreground">Spend</div>
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
					title="Totals unavailable"
					action={retryAction("totals")}
					className="py-6 md:p-6"
				/>
			)}

			<SettingsSection headingLevel={3} title="Spend over time">
				{missingSections.has("by_day") ? (
					<EmptyState
						variant="inset"
						title="Trend unavailable"
						action={retryAction("by_day")}
						className="py-4 md:p-4"
					/>
				) : sortedDays.length === 0 ? (
					<EmptyState variant="inset" title="No usage" className="py-4 md:p-4" />
				) : (
					<DailyUsageChart days={sortedDays} />
				)}
			</SettingsSection>

			<SettingsSection headingLevel={3} title="Models">
				{missingSections.has("by_model") ? (
					<EmptyState
						variant="inset"
						title="Models unavailable"
						action={retryAction("by_model")}
						className="py-4 md:p-4"
					/>
				) : sortedModels.length === 0 ? (
					<EmptyState variant="inset" title="No usage" className="py-4 md:p-4" />
				) : (
					<table className="w-full table-fixed">
						<caption className="sr-only">Usage by model</caption>
						<colgroup>
							<col />
							<col className="w-[5.5rem] sm:w-28" />
							<col className="w-[5.5rem] sm:w-28" />
						</colgroup>
						<thead>
							<tr className="border-b text-xs text-muted-foreground">
								<th scope="col" className="pb-2 text-left font-medium">
									Model
								</th>
								<th scope="col" className="pb-2 text-right font-medium">
									Requests
								</th>
								<th scope="col" className="pb-2 text-right font-medium">
									Spend
								</th>
							</tr>
						</thead>
						<tbody className="divide-y">
							{sortedModels.map((model) => {
								const providerId = model.provider ?? MANAGED_PROVIDER_ID;
								const modelName = modelDisplayName(
									model.model,
									modelOptionsForProvider(providerId, providers, managedModels),
								);
								return (
									<tr key={`${model.provider ?? "managed"}:${model.model}`}>
										<td className="min-w-0 py-3 pr-3 align-top">
											<div className="flex min-w-0 items-center gap-2">
												<ProviderIcon provider={providerId} providers={providers} size="sm" />
												<div className="min-w-0">
													<div className="truncate text-sm font-medium">{modelName}</div>
													<div className="truncate text-xs text-muted-foreground">
														{providerDisplayLabel(providerId, providers)}
													</div>
												</div>
											</div>
										</td>
										<td className="py-3 text-right align-top text-sm tabular-nums">
											{model.requests.toLocaleString()}
										</td>
										<td className="py-3 text-right align-top text-sm font-medium tabular-nums">
											{formatUsdExact(model.amount_usd)}
										</td>
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
	const amounts = days.map((day) => Number(day.amount_usd));
	const maxAmount = Math.max(...amounts, 0);
	const totalAmount = amounts.reduce((total, amount) => total + amount, 0);
	const firstDay = days[0];
	const lastDay = days.at(-1);

	return (
		<div
			role="img"
			aria-label={`Daily spend from ${firstDay ? formatShortDate(firstDay.date) : "the start of the window"} to ${lastDay ? formatShortDate(lastDay.date) : "the end of the window"}: ${formatUsdExact(String(totalAmount))} total.`}
		>
			<div className="mb-3 flex justify-end text-xs text-muted-foreground">
				<span className="font-medium tabular-nums text-foreground">
					Peak {formatUsdExact(String(maxAmount))}
				</span>
			</div>
			<div className="flex h-36 items-end gap-px border-b sm:h-44 sm:gap-1" aria-hidden="true">
				{days.map((day, index) => {
					const amount = amounts[index] ?? 0;
					const height = maxAmount > 0 ? (amount / maxAmount) * 100 : 0;
					const label = `${formatShortDate(day.date)} · ${formatUsdExact(day.amount_usd)}`;
					return (
						<div
							key={day.date}
							className="group flex h-full min-w-0 flex-1 items-end"
							title={label}
						>
							<div
								className={
									amount > 0
										? "w-full rounded-t-sm bg-primary/75 group-hover:bg-primary"
										: "h-0.5 w-full bg-muted"
								}
								style={amount > 0 ? { height: `${height}%`, minHeight: "2px" } : undefined}
							/>
						</div>
					);
				})}
			</div>
			<div className="mt-2 flex justify-between text-xs text-muted-foreground">
				<span>{firstDay ? formatShortDate(firstDay.date) : null}</span>
				{lastDay && lastDay.date !== firstDay?.date ? (
					<span>{formatShortDate(lastDay.date)}</span>
				) : null}
			</div>
		</div>
	);
}

function UsageRetryButton({ isRetrying, onRetry }: { isRetrying: boolean; onRetry: () => void }) {
	return (
		<Button type="button" variant="outline" size="sm" onClick={onRetry} disabled={isRetrying}>
			{isRetrying ? <Spinner className="size-4" /> : <RefreshCw className="size-4" />}
			Retry
		</Button>
	);
}
