"use client";

import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { EmptyState } from "@/components/empty-state";
import { SettingsPanelHeader } from "@/components/settings/settings-panel-header";
import { SettingsSection } from "@/components/settings-section";
import { Button } from "@/components/ui/button";
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

const DESCRIPTION = "Clawdi AI spend and requests for the current reporting window.";
const USAGE_PAGE_CLASS = "flex flex-col gap-8 px-5 sm:px-6 lg:px-8";

type VisibleUsageSection = "totals" | "by_agent" | "by_model";
type AgentBreakdown = NonNullable<HostedUsageSummary["by_agent"]>[number];
type ModelBreakdown = HostedUsageSummary["by_model"][number];

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
	return [
		(match[1] ?? "0").replace(/^0+(?=\d)/, ""),
		(match[2] ?? "").replace(/0+$/, ""),
	];
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

function unavailableUsageSections(
	usage: HostedUsageSummary,
	agentBreakdown: readonly AgentBreakdown[] | null,
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
	return sections;
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
	const agentBreakdown = Array.isArray(usage.by_agent) ? usage.by_agent : null;
	const missingSections = unavailableUsageSections(usage, agentBreakdown);
	const totals =
		!missingSections.has("totals") && usage.total_usd !== null && usage.total_requests !== null
			? { usd: usage.total_usd, requests: usage.total_requests }
			: null;
	const sortedAgents = agentBreakdown ? [...agentBreakdown].sort(sortAgentBreakdown) : [];
	const sortedModels = [...usage.by_model].sort(sortModelBreakdown);
	const windowLabel = `${formatShortDate(usage.period_start)} – ${formatShortDate(usage.period_end)}`;

	if (
		missingSections.has("totals") &&
		missingSections.has("by_agent") &&
		missingSections.has("by_model")
	) {
		return (
			<div data-hosted="true" className={USAGE_PAGE_CLASS}>
				<SettingsPanelHeader title="Usage" description={`${windowLabel} reporting window.`} />
				<EmptyState
					variant="inset"
					title="We can’t load your usage right now"
					description="The usage provider is temporarily unavailable. No spend, agent, or model values are shown."
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
		sortedModels.length === 0;

	if (isRealZero) {
		return (
			<div data-hosted="true" className={USAGE_PAGE_CLASS}>
				<SettingsPanelHeader title="Usage" description={`${windowLabel} reporting window.`} />
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
			<SettingsPanelHeader title="Usage" description={`${windowLabel} reporting window.`} />

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

			<SettingsSection
				headingLevel={3}
				title="By agent"
				description="Spend and requests grouped by agent."
			>
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
								const displayName = agent.agent_name
									? deploymentDisplayName(agent.agent_name)
									: "Unattributed";
								return (
									<tr key={agent.agent_id ?? "unattributed"}>
										<td className="min-w-0 py-3 pr-3 align-top">
											<div className="truncate text-sm font-medium">{displayName}</div>
											<div
												className={
													agent.agent_id
														? "truncate font-mono text-[11px] text-muted-foreground"
														: "text-xs leading-4 text-muted-foreground"
												}
											title={agent.agent_id ?? undefined}
										>
												{agent.agent_id ?? "Usage not linked to an agent"}
											</div>
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
				description="Spend and requests grouped by provider and model."
			>
				{missingSections.has("by_model") ? (
					<EmptyState
						variant="inset"
						title="Model breakdown unavailable"
						description="The model breakdown could not be read. No model values are shown."
						action={retryAction("by_model")}
						className="py-4 md:p-4"
					/>
				) : sortedModels.length === 0 ? (
					<EmptyState
						variant="inset"
						description="No model usage in this reporting window"
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
