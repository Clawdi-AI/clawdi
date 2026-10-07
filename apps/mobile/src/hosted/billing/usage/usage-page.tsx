import { billingPageClass, usagePageClasses as styles } from "@clawdi/shared/ui";
import {
	type AgentTile,
	compareDecimals,
	completeDailyBreakdown,
	usageCopy as copy,
	dailySpendLabel,
	dailyUsageTotals,
	decimalRatioPercent,
	formatUsageDate,
	formatUsdExact,
	type HostedUsageSummary,
	MANAGED_PROVIDER_ID,
	modelDisplayName,
	modelOptionsForProvider,
	providerDisplayLabel,
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
	type VisibleUsageSection,
} from "@clawdi/shared/view";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { cn } from "cn";
import { RefreshCw } from "lucide-react-native";
import { type ReactNode, useState } from "react";
import { RefreshControl } from "react-native";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { EmptyState } from "@/components/empty-state";
import { SettingsPanelHeader, SettingsSection } from "@/components/settings/settings-panel-header";
import { SettingsShell } from "@/components/settings/shell";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/feedback";
import { Icon } from "@/components/ui/icon";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Text } from "@/components/ui/text";
import { AppView } from "@/components/ui/view";
import { WebText, WebView } from "@/components/ui/web-layout";
import { useDashboardAgents } from "@/hooks/use-dashboard-agents";
import { formatCredits } from "@/hosted/billing/store/store-presentation";
import { ProviderIcon } from "@/hosted/v2/ai-providers/provider-icon";
import { useProviderInventory } from "@/hosted/v2/ai-providers/providers-hooks";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useStoreSurfaces } from "@/platform/store/store-provider";

type UsageRangeSelection = { days: UsageRangeDays; onChange: (days: UsageRangeDays) => void };
type SavedProviders = NonNullable<ReturnType<typeof useProviderInventory>["data"]>["providers"];
type ManagedModels = Parameters<typeof modelOptionsForProvider>[2];

function useUsage(days: UsageRangeDays, agentId: string | null, enabled = true) {
	const { compute } = useMobileApi();
	const scope = useAccountScope();
	const read = useAccountRead();
	return useQuery({
		queryKey: accountQueryKey(scope, "billing-usage", days, agentId),
		queryFn: ({ signal }) =>
			read((s) => {
				if (!compute) throw new Error("Compute API unavailable");
				return compute.getUsage({ days, agent_id: agentId ?? undefined }, s);
			}, signal),
		enabled: scope.isReady && Boolean(compute) && enabled,
		retry: false,
		placeholderData: keepPreviousData,
	});
}

function useManagedModelCatalog() {
	const { compute } = useMobileApi();
	const scope = useAccountScope();
	const read = useAccountRead();
	return useQuery({
		queryKey: accountQueryKey(scope, "managed-model-catalog"),
		queryFn: ({ signal }) =>
			read((s) => {
				if (!compute) throw new Error("Compute API unavailable");
				return compute.getManagedModels(s);
			}, signal),
		enabled: scope.isReady && Boolean(compute),
		retry: false,
		staleTime: 5 * 60_000,
	});
}

/** Wallet USD, shown as credits in store builds like the rest of the Wallet. */
function useUsageAmount() {
	const t = useI18n();
	const surfaces = useStoreSurfaces();
	return (usd: string) =>
		surfaces.creditUnits ? formatCredits(usd, t("store.credits")) : formatUsdExact(usd);
}

/** Web settings "AI Usage" panel (hosted/billing/usage/usage-page.tsx), read-only. */
export function UsageScreen() {
	const scope = useAccountScope();
	return <UsageView key={`${scope.accountKey}:${scope.generation}`} />;
}

function UsageView() {
	const t = useI18n();
	const { compute } = useMobileApi();
	const [rangeDays, setRangeDays] = useState<UsageRangeDays>(7);
	const [selectedAgentId, setSelectedAgentId] = useState("all");
	const allUsage = useUsage(rangeDays, null);
	const scopedUsage = useUsage(
		rangeDays,
		selectedAgentId === "all" ? null : selectedAgentId,
		selectedAgentId !== "all",
	);
	const usage = selectedAgentId === "all" ? allUsage : scopedUsage;
	const providers = useProviderInventory();
	const managedModelCatalog = useManagedModelCatalog();
	const { tiles } = useDashboardAgents();
	const [manualRetrying, setManualRetrying] = useState(false);
	const agentOptions = Array.isArray(allUsage.data?.by_agent) ? allUsage.data.by_agent : [];
	const rangeSelection = { days: rangeDays, onChange: setRangeDays };
	const filters = (
		<UsageFilters
			agents={agentOptions}
			agentTiles={tiles}
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
	const onRetry = () => void retryUsage();

	let body: ReactNode;
	if (!compute) {
		body = (
			<>
				<SettingsPanelHeader title={copy.title} />
				<EmptyState variant="inset" title={t("billing.unavailable")} />
			</>
		);
	} else if (allUsage.isPending || (selectedAgentId !== "all" && scopedUsage.isPending)) {
		body = (
			<>
				<SettingsPanelHeader
					title={copy.title}
					description={
						// Same text length as the loaded date window, so the header keeps its size.
						<Text className="bg-muted text-transparent">Jan 1, 2026 – Jan 31, 2026 · UTC</Text>
					}
					actions={filters}
				/>
				<UsageSkeleton />
			</>
		);
	} else if (!usage.data) {
		body = (
			<>
				<SettingsPanelHeader title={copy.title} actions={filters} />
				<ApiErrorPanel error={usage.error} onRetry={onRetry} />
			</>
		);
	} else {
		body = (
			<UsageSummaryView
				usage={usage.data}
				filters={filters}
				providers={providers.data?.providers ?? []}
				managedModels={managedModelCatalog.data?.models ?? []}
				isRetrying={manualRetrying}
				onRetry={onRetry}
			/>
		);
	}
	return (
		<SettingsShell
			refreshControl={
				compute ? <RefreshControl refreshing={manualRetrying} onRefresh={onRetry} /> : undefined
			}
		>
			<WebView recipe={billingPageClass}>{body}</WebView>
		</SettingsShell>
	);
}

function UsageFilters({
	agents,
	agentTiles,
	selectedAgentId,
	onAgentChange,
	range,
}: {
	agents: readonly UsageAgentBreakdown[];
	agentTiles: readonly AgentTile[];
	selectedAgentId: string;
	onAgentChange: (agentId: string) => void;
	range: UsageRangeSelection;
}) {
	const selectableAgents = usageAgentOptions(agents, agentTiles);
	return (
		<>
			<WebView recipe={styles.agentFilter}>
				<Select value={selectedAgentId} onValueChange={onAgentChange}>
					<SelectTrigger className="w-full">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="all" label={copy.allAgents} />
						{selectableAgents.map((agent) => {
							const label = usageAgentText(agent.identity);
							return (
								<SelectItem
									key={agent.id}
									value={agent.id}
									// Native menu items are plain text; Web's "Deleted" badge becomes a suffix.
									label={agent.deleted ? `${label} · ${copy.deleted}` : label}
								/>
							);
						})}
					</SelectContent>
				</Select>
			</WebView>
			<WebView recipe={styles.rangeFilter}>
				<Select
					value={String(range.days)}
					onValueChange={(value) => range.onChange(usageRangeDays(value))}
				>
					<SelectTrigger className="w-full">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{USAGE_RANGE_ITEMS.map((item) => (
							<SelectItem key={item.value} value={item.value} label={item.label} />
						))}
					</SelectContent>
				</Select>
			</WebView>
		</>
	);
}

function UsageSummaryView({
	usage,
	filters,
	providers,
	managedModels,
	isRetrying,
	onRetry,
}: {
	usage: HostedUsageSummary;
	filters: ReactNode;
	providers: SavedProviders;
	managedModels: ManagedModels;
	isRetrying: boolean;
	onRetry: () => void;
}) {
	const amount = useUsageAmount();
	const missingSections = unavailableUsageSections(usage);
	const totals =
		!missingSections.has("totals") && usage.total_usd !== null && usage.total_requests !== null
			? { usd: usage.total_usd, requests: usage.total_requests }
			: null;
	const sortedDays = completeDailyBreakdown(usage.by_day, usage.period_start, usage.period_end);
	const sortedModels = [...usage.by_model].sort(sortModelBreakdown);
	const modelsTruncated = (usage.truncated_sections ?? []).includes("by_model");
	const header = (
		<SettingsPanelHeader
			title={copy.title}
			description={usageWindowLabel(usage)}
			actions={filters}
		/>
	);

	if (
		missingSections.has("totals") &&
		missingSections.has("by_model") &&
		missingSections.has("by_day")
	) {
		return (
			<>
				{header}
				<EmptyState
					variant="inset"
					title={copy.usageUnavailable}
					action={<UsageRetryButton isRetrying={isRetrying} onRetry={onRetry} />}
					className={styles.pageEmpty}
				/>
			</>
		);
	}

	const retrySection = usageRetrySection(missingSections);
	const retryAction = (section: VisibleUsageSection) =>
		retrySection === section ? (
			<UsageRetryButton isRetrying={isRetrying} onRetry={onRetry} />
		) : null;

	return (
		<>
			{header}
			{totals ? (
				<WebView recipe={styles.summary} accessibilityLabel={copy.summary}>
					<WebView recipe={styles.summaryCell}>
						<WebText recipe={styles.summaryLabel}>{copy.spend}</WebText>
						<WebText recipe={styles.summaryValue}>{amount(totals.usd)}</WebText>
					</WebView>
					<WebView recipe={styles.summaryCellNext}>
						<WebText recipe={styles.summaryLabel}>{copy.requests}</WebText>
						<WebText recipe={styles.summaryValue}>{totals.requests.toLocaleString()}</WebText>
					</WebView>
				</WebView>
			) : (
				<EmptyState
					variant="inset"
					title={copy.totalsUnavailable}
					action={retryAction("totals")}
					className={styles.totalsEmpty}
				/>
			)}

			<SettingsSection title={copy.spendOverTime}>
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
					<WebView recipe={styles.table} accessibilityLabel={copy.usageByModel}>
						<WebView recipe={styles.headRow} className="flex-row">
							<WebText recipe={styles.headCell} className="flex-1">
								{copy.model}
							</WebText>
							<WebText recipe={cn(styles.headNumericCell, styles.numericColumn)}>
								{copy.requests}
							</WebText>
							<WebText recipe={cn(styles.headNumericCell, styles.numericColumn)}>
								{copy.spend}
							</WebText>
						</WebView>
						{sortedModels.map((model, index) => {
							const providerId = model.provider ?? MANAGED_PROVIDER_ID;
							const modelName = modelDisplayName(
								model.model,
								modelOptionsForProvider(providerId, providers, managedModels),
							);
							return (
								<AppView
									key={`${model.provider ?? "managed"}:${model.model}`}
									// Web's `divide-y` table body.
									className={cn("flex-row", index > 0 && "border-t border-border")}
								>
									<WebView recipe={styles.modelCell} className="flex-1">
										<WebView recipe={styles.modelIdentity}>
											<ProviderIcon provider={providerId} providers={providers} size="sm" />
											<WebView recipe={styles.modelCopy} className="flex-1">
												<WebText recipe={styles.modelName} numberOfLines={1}>
													{modelName}
												</WebText>
												<WebText recipe={styles.modelProvider} numberOfLines={1}>
													{providerDisplayLabel(providerId, providers)}
												</WebText>
											</WebView>
										</WebView>
									</WebView>
									<WebText recipe={cn(styles.requestsCell, styles.numericColumn)}>
										{model.requests.toLocaleString()}
									</WebText>
									<WebText recipe={cn(styles.spendCell, styles.numericColumn)}>
										{amount(model.amount_usd)}
									</WebText>
								</AppView>
							);
						})}
					</WebView>
				)}
			</SettingsSection>
		</>
	);
}

function DailyUsageChart({ days }: { days: readonly UsageDayBreakdown[] }) {
	const amount = useUsageAmount();
	const { peak, total } = dailyUsageTotals(days);
	const firstDay = days[0];
	const lastDay = days.at(-1);
	return (
		<AppView
			accessible
			accessibilityRole="image"
			accessibilityLabel={dailySpendLabel(days, amount(total))}
		>
			<WebView recipe={styles.chartPeakRow}>
				<WebText recipe={styles.chartPeak}>
					{copy.peak} {amount(peak)}
				</WebText>
			</WebView>
			<WebView recipe={styles.chartBars}>
				{days.map((day) => {
					const positive = compareDecimals(day.amount_usd, "0") === 1;
					return (
						<WebView key={day.date} recipe={styles.chartColumn}>
							<WebView
								recipe={positive ? styles.chartBar : styles.chartBarEmpty}
								style={
									positive
										? {
												height: `${decimalRatioPercent(day.amount_usd, peak)}%`,
												minHeight: 2,
											}
										: undefined
								}
							/>
						</WebView>
					);
				})}
			</WebView>
			<WebView recipe={styles.chartAxis}>
				<Text>{firstDay ? formatUsageDate(firstDay.date) : null}</Text>
				{lastDay && lastDay.date !== firstDay?.date ? (
					<Text>{formatUsageDate(lastDay.date)}</Text>
				) : null}
			</WebView>
		</AppView>
	);
}

function UsageRetryButton({ isRetrying, onRetry }: { isRetrying: boolean; onRetry: () => void }) {
	return (
		<Button variant="outline" size="sm" onPress={onRetry} disabled={isRetrying}>
			{isRetrying ? <Spinner /> : <Icon as={RefreshCw} />}
			<Text>{copy.retry}</Text>
		</Button>
	);
}

/** Web billing/components/state-views.tsx UsageSkeleton. */
function UsageSkeleton() {
	return (
		<AppView
			className="gap-8"
			accessibilityElementsHidden
			importantForAccessibility="no-hide-descendants"
		>
			<WebView recipe={styles.summary}>
				{[copy.spend, copy.requests].map((label, index) => (
					<WebView key={label} recipe={index === 0 ? styles.summaryCell : styles.summaryCellNext}>
						<WebText recipe={styles.summaryLabel}>{label}</WebText>
						<Skeleton className="h-9 w-28" />
					</WebView>
				))}
			</WebView>
			<SettingsSection title={copy.spendOverTime}>
				<AppView className="mb-3 flex-row justify-end">
					<Skeleton className="h-4 w-24" />
				</AppView>
				<Skeleton className="h-36 w-full" />
				<AppView className="mt-2 flex-row justify-between">
					<Skeleton className="h-4 w-12" />
					<Skeleton className="h-4 w-12" />
				</AppView>
			</SettingsSection>
			<SettingsSection title={copy.models}>
				<AppView className="border-b border-border pb-2">
					<Skeleton className="h-4 w-16" />
				</AppView>
				{[0, 1, 2].map((row) => (
					<AppView
						key={row}
						className={cn("flex-row items-start gap-2 py-3", row > 0 && "border-t border-border")}
					>
						<Skeleton className="size-8 rounded-md" />
						<AppView className="min-w-0 flex-1 gap-1">
							<Skeleton className="h-5 w-40 max-w-full" />
							<Skeleton className="h-4 w-24" />
						</AppView>
						<Skeleton className="h-5 w-16" />
					</AppView>
				))}
			</SettingsSection>
		</AppView>
	);
}
