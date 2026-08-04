"use client";

import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { AgentLabel, agentIdentity } from "@/components/dashboard/agent-label";
import type { AgentTile } from "@/components/dashboard/agents-card";
import { EmptyState } from "@/components/empty-state";
import { SettingsPanelHeader } from "@/components/settings/settings-panel-header";
import { SettingsSection } from "@/components/settings-section";
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

const DESCRIPTION = "Clawdi AI spend and requests.";
const USAGE_PAGE_CLASS = "flex flex-col gap-8 px-5 sm:px-6 lg:px-8";
const USAGE_RANGE_ITEMS = [
	{ label: "Current period", value: "current" },
	{ label: "Last 7 days", value: "7" },
	{ label: "Last 30 days", value: "30" },
	{ label: "Last 90 days", value: "90" },
] as const;

type VisibleUsageSection = "totals" | "by_agent" | "by_model" | "by_day";
type UsageRangeDays = 7 | 30 | 90 | null;
type UsageRangeSelection = {
	days: UsageRangeDays;
	onChange: (days: UsageRangeDays) => void;
};
type AgentBreakdown = NonNullable<HostedUsageSummary["by_agent"]>[number];
type ModelBreakdown = HostedUsageSummary["by_model"][number];
type DayBreakdown = HostedUsageSummary["by_day"][number];
type ScopedAgentBreakdown = AgentBreakdown & {
	agent_id: string;
	by_model: ModelBreakdown[];
};

type UsageAgentIdentity = {
	name: string | null;
	displayName: string | null;
	defaultName: string | null;
	machineName: string | null;
	type: string | null;
	avatarUrl: string | null;
};

function decimalUsdIsZero(value: string): boolean {
	return /^[+-]?0+(?:\.0+)?$/.test(value.trim());
}

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

function hasAgentModelBreakdown(agent: AgentBreakdown): agent is ScopedAgentBreakdown {
	return typeof agent.agent_id === "string" && Array.isArray(agent.by_model);
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
		avatarUrl: env?.avatar_url ?? tile?.avatarUrl ?? null,
	};
}

function usageAgentLabel(identity: UsageAgentIdentity): string {
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

export function usageModelsForAgentScope(
	usage: HostedUsageSummary,
	agentId: string,
): readonly ModelBreakdown[] {
	if (agentId === "all" || !Array.isArray(usage.by_agent)) return usage.by_model;
	const agent = usage.by_agent.find((candidate) => candidate.agent_id === agentId);
	return Array.isArray(agent?.by_model) ? agent.by_model : usage.by_model;
}

function unavailableUsageSections(
	usage: HostedUsageSummary,
	agentBreakdown: readonly AgentBreakdown[] | null,
	dailyBreakdown: readonly DayBreakdown[] | null,
): Set<VisibleUsageSection> {
	const sections = new Set<VisibleUsageSection>();
	if (
		usage.unavailable_sections.includes("totals") ||
		usage.total_usd === null ||
		usage.total_requests === null
	) {
		sections.add("totals");
	}
	if (usage.unavailable_sections.includes("by_agent") || agentBreakdown === null) {
		sections.add("by_agent");
	}
	if (usage.unavailable_sections.includes("by_model")) sections.add("by_model");
	if (usage.unavailable_sections.includes("by_day") || dailyBreakdown === null) {
		sections.add("by_day");
	}
	return sections;
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
			return null;
	}
}

function UsageRangeSelect({
	days,
	onChange,
}: {
	days: UsageRangeDays;
	onChange: (days: UsageRangeDays) => void;
}) {
	return (
		<Select
			items={USAGE_RANGE_ITEMS}
			value={days === null ? "current" : String(days)}
			onValueChange={(value) => onChange(usageRangeDays(value))}
		>
			<SelectTrigger aria-label="Reporting range" className="w-40">
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
	);
}

export function UsagePage({ agentTiles }: { agentTiles: readonly AgentTile[] }) {
	const [rangeDays, setRangeDays] = useState<UsageRangeDays>(null);
	const usage = useUsage(rangeDays);
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
				<SettingsPanelHeader
					title="Usage"
					description={DESCRIPTION}
					actions={<UsageRangeSelect days={rangeDays} onChange={setRangeDays} />}
				/>
				<UsageSkeleton />
			</div>
		);
	}

	if (shouldBlockQueryError(usage.error, usage.data) || !usage.data) {
		return (
			<div data-hosted="true" className={USAGE_PAGE_CLASS}>
				<SettingsPanelHeader
					title="Usage"
					description={DESCRIPTION}
					actions={<UsageRangeSelect days={rangeDays} onChange={setRangeDays} />}
				/>
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
			agentTiles={agentTiles}
			providers={providers.data ?? []}
			managedModels={managedModelCatalog.data?.models ?? []}
			rangeSelection={{ days: rangeDays, onChange: setRangeDays }}
			isRetrying={manualRetrying}
			onRetry={() => {
				void retryUsage();
			}}
		/>
	);
}

export function UsageSummaryView({
	usage,
	agentTiles = [],
	providers,
	managedModels,
	rangeSelection,
	isRetrying,
	onRetry,
}: {
	usage: HostedUsageSummary;
	agentTiles?: readonly AgentTile[];
	providers: readonly AiProvider[];
	managedModels: readonly ManagedModelCatalogItem[];
	rangeSelection?: UsageRangeSelection;
	isRetrying: boolean;
	onRetry: () => void;
}) {
	const [selectedAgentId, setSelectedAgentId] = useState("all");
	const agentBreakdown = Array.isArray(usage.by_agent) ? usage.by_agent : null;
	const dailyBreakdown = Array.isArray(usage.by_day) ? usage.by_day : null;
	const missingSections = unavailableUsageSections(usage, agentBreakdown, dailyBreakdown);
	const totals =
		!missingSections.has("totals") && usage.total_usd !== null && usage.total_requests !== null
			? { usd: usage.total_usd, requests: usage.total_requests }
			: null;
	const sortedAgents = agentBreakdown ? [...agentBreakdown].sort(sortAgentBreakdown) : [];
	const sortedDays = dailyBreakdown
		? [...dailyBreakdown].sort((left, right) => compareStableText(left.date, right.date))
		: [];
	const selectableAgents = sortedAgents.filter(hasAgentModelBreakdown);
	const selectedAgent = selectableAgents.find((agent) => agent.agent_id === selectedAgentId);
	const effectiveAgentId = selectedAgent?.agent_id ?? "all";
	const scopedModels = usageModelsForAgentScope(usage, effectiveAgentId);
	const sortedModels = [...scopedModels].sort(sortModelBreakdown);
	const scopeItems = [
		{ label: "All agents", value: "all" },
		...selectableAgents.map((agent) => ({
			label: usageAgentLabel(usageAgentIdentity(agent, agentTiles)),
			value: agent.agent_id,
		})),
	];
	const windowLabel = `${formatShortDate(usage.period_start)} – ${formatShortDate(usage.period_end)}`;
	const rangeAction = rangeSelection ? (
		<UsageRangeSelect days={rangeSelection.days} onChange={rangeSelection.onChange} />
	) : null;

	if (
		missingSections.has("totals") &&
		missingSections.has("by_agent") &&
		missingSections.has("by_model") &&
		missingSections.has("by_day")
	) {
		return (
			<div data-hosted="true" className={USAGE_PAGE_CLASS}>
				<SettingsPanelHeader title="Usage" description={windowLabel} actions={rangeAction} />
				<EmptyState
					variant="inset"
					title="We can’t load your usage right now"
					description="The usage provider is temporarily unavailable. No usage values are shown."
					action={<UsageRetryButton isRetrying={isRetrying} onRetry={onRetry} />}
					className="py-10 md:p-10"
				/>
			</div>
		);
	}

	const isRealZero =
		totals !== null &&
		decimalUsdIsZero(totals.usd) &&
		totals.requests === 0 &&
		!missingSections.has("by_agent") &&
		sortedAgents.length === 0 &&
		!missingSections.has("by_model") &&
		sortedModels.length === 0 &&
		!missingSections.has("by_day") &&
		sortedDays.length === 0;

	if (isRealZero) {
		return (
			<div data-hosted="true" className={USAGE_PAGE_CLASS}>
				<SettingsPanelHeader title="Usage" description={windowLabel} actions={rangeAction} />
				<EmptyState
					variant="inset"
					title="No usage yet"
					description="Once your agents start running, Clawdi AI spend shows up here."
					className="py-10 md:p-10"
				/>
			</div>
		);
	}

	const retrySection: VisibleUsageSection | null = missingSections.has("totals")
		? "totals"
		: missingSections.has("by_day")
			? "by_day"
			: missingSections.has("by_agent")
				? "by_agent"
				: missingSections.has("by_model")
					? "by_model"
					: null;
	const retryAction = (section: VisibleUsageSection) =>
		retrySection === section ? (
			<UsageRetryButton isRetrying={isRetrying} onRetry={onRetry} />
		) : null;

	return (
		<div data-hosted="true" className={USAGE_PAGE_CLASS}>
			<SettingsPanelHeader title="Usage" description={windowLabel} actions={rangeAction} />

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
					description="Spend and request totals could not be read."
					action={retryAction("totals")}
					className="py-6 md:p-6"
				/>
			)}

			<SettingsSection headingLevel={3} title="Daily usage">
				{missingSections.has("by_day") ? (
					<EmptyState
						variant="inset"
						title="Daily usage unavailable"
						description="The daily trend could not be read."
						action={retryAction("by_day")}
						className="py-4 md:p-4"
					/>
				) : sortedDays.length === 0 ? (
					<EmptyState
						variant="inset"
						description="No daily usage in this reporting window"
						className="py-4 md:p-4"
					/>
				) : (
					<DailyUsageChart days={sortedDays} />
				)}
			</SettingsSection>

			<SettingsSection headingLevel={3} title="By agent">
				{missingSections.has("by_agent") ? (
					<EmptyState
						variant="inset"
						title="Agent breakdown unavailable"
						description="Agent attribution could not be read. No agent values are shown."
						action={retryAction("by_agent")}
						className="py-4 md:p-4"
					/>
				) : sortedAgents.length === 0 ? (
					<EmptyState
						variant="inset"
						description="No agent usage in this reporting window"
						className="py-4 md:p-4"
					/>
				) : (
					<table className="w-full table-fixed">
						<caption className="sr-only">Clawdi AI usage grouped by agent</caption>
						<colgroup>
							<col />
							<col className="w-[5.5rem] sm:w-28" />
							<col className="w-[5.5rem] sm:w-28" />
						</colgroup>
						<thead>
							<tr className="border-b text-xs text-muted-foreground">
								<th scope="col" className="pb-2 text-left font-medium">
									Agent
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
							{sortedAgents.map((agent) => {
								const identity = usageAgentIdentity(agent, agentTiles);
								return (
									<tr key={agent.agent_id ?? "unattributed"}>
										<td className="min-w-0 py-3 pr-3 align-top">
											{agent.agent_id ? (
												<AgentLabel
													name={identity.name}
													displayName={identity.displayName}
													defaultName={identity.defaultName}
													machineName={identity.machineName}
													type={identity.type}
													avatarUrl={identity.avatarUrl}
													size="sm"
												/>
											) : (
												<div className="space-y-0.5">
													<div className="text-sm font-medium">Unattributed</div>
													<div className="text-xs leading-4 text-muted-foreground">
														Usage not linked to an agent
													</div>
												</div>
											)}
										</td>
										<td className="py-3 text-right align-top text-sm tabular-nums">
											{agent.requests.toLocaleString()}
										</td>
										<td className="py-3 text-right align-top text-sm font-medium tabular-nums">
											{formatUsdExact(agent.amount_usd)}
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				)}
			</SettingsSection>

			<SettingsSection
				headingLevel={3}
				title="By model"
				actions={
					!missingSections.has("by_model") && selectableAgents.length > 0 ? (
						<Select
							items={scopeItems}
							value={effectiveAgentId}
							onValueChange={(value) => setSelectedAgentId(value ?? "all")}
						>
							<SelectTrigger aria-label="Agent scope" className="w-44 sm:w-56">
								<SelectValue />
							</SelectTrigger>
							<SelectContent align="end">
								{scopeItems.map((item) => (
									<SelectItem key={item.value} value={item.value}>
										{item.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					) : null
				}
			>
				{missingSections.has("by_model") ? (
					<EmptyState
						variant="inset"
						title="Model breakdown unavailable"
						description="The model breakdown could not be read. No model values are shown."
						action={retryAction("by_model")}
						className="py-4 md:p-4"
					/>
				) : (
					<div>
						{sortedModels.length === 0 ? (
							<EmptyState
								variant="inset"
								description={
									selectedAgent
										? "No model usage for this agent in the reporting window"
										: "No model usage in this reporting window"
								}
								className="py-4 md:p-4"
							/>
						) : (
							<table className="w-full table-fixed">
								<caption className="sr-only">Clawdi AI usage grouped by provider and model</caption>
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
					</div>
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
			aria-label={`Daily Clawdi AI spend from ${firstDay ? formatShortDate(firstDay.date) : "the start of the window"} to ${lastDay ? formatShortDate(lastDay.date) : "the end of the window"}: ${formatUsdExact(String(totalAmount))} total.`}
			className="rounded-lg border bg-muted/10 p-4 sm:p-5"
		>
			<div className="mb-3 flex items-center justify-between gap-3 text-xs text-muted-foreground">
				<span>Daily spend</span>
				<span className="font-medium tabular-nums text-foreground">
					Peak {formatUsdExact(String(maxAmount))}
				</span>
			</div>
			<div className="flex h-36 items-end gap-1 border-b sm:h-44" aria-hidden="true">
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
								className="w-full rounded-t-sm bg-primary/75 group-hover:bg-primary"
								style={{ height: `${height}%`, minHeight: amount > 0 ? "2px" : undefined }}
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
		<Button type="button" variant="outline" size="sm" disabled={isRetrying} onClick={onRetry}>
			{isRetrying ? <Spinner className="size-3.5" /> : <RefreshCw className="size-3.5" />}
			Retry
		</Button>
	);
}
