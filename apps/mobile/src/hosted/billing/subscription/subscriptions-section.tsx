import { billingPageStackClass, transactionsSectionClasses } from "@clawdi/shared/ui";
import {
	BILLING_ERROR_TITLES,
	computeSubscriptionListCopy as copy,
	isHistoricalAccountSubscription,
	OVERVIEW_COPY,
	reusableInventoryState,
	shouldBlockQueryError,
	sortLoadedSubscriptions,
} from "@clawdi/shared/view";
import { useQuery } from "@tanstack/react-query";
import RotateCcwClock from "lucide-react-native/icons/rotate-ccw-clock";
import { useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { EmptyState } from "@/components/empty-state";
import { RouteLoadingSkeleton } from "@/components/route-loading-skeleton";
import { SettingsPanelHeader, SettingsSection } from "@/components/settings/settings-panel-header";
import { SettingsShell } from "@/components/settings/shell";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { NativeList } from "@/components/ui/native-list";
import { Text } from "@/components/ui/text";
import { AppView } from "@/components/ui/view";
import { WebText, WebView } from "@/components/ui/web-layout";
import { useDashboardAgents } from "@/hooks/use-dashboard-agents";
import { billingErrorNormalizer } from "@/hosted/billing/errors";
import { uniqueBillingItems } from "@/hosted/billing/format";
import { useReusableSubscriptions, useSubscriptions } from "@/hosted/billing/hooks";
import { useCreditsNotice } from "@/hosted/billing/store/add-credits";
import { StoreComputeBillingSection } from "@/hosted/billing/store/compute-store";
import { PlanComparison } from "@/hosted/billing/subscription/plan-comparison";
import { SubscriptionRow } from "@/hosted/billing/subscription/subscription-row";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";

export function BillingScreen() {
	const scope = useAccountScope();
	return <BillingView key={`${scope.accountKey}:${scope.generation}`} />;
}

/** Web's Compute page: subscriptions with inline actions and history, then the plans. */
function BillingView() {
	const t = useI18n();
	const scope = useAccountScope();
	const { compute } = useMobileApi();
	const read = useAccountRead();
	const creditsNotice = useCreditsNotice();
	const subscriptions = useSubscriptions();
	const reusable = useReusableSubscriptions();
	const { inventory, tiles } = useDashboardAgents();
	const [showHistory, setShowHistory] = useState(false);
	const plans = useQuery({
		queryKey: accountQueryKey(scope, "billing-plans"),
		queryFn: ({ signal }) =>
			read((s) => {
				if (!compute) throw new Error("Compute API unavailable");
				return compute.listPlans(s);
			}, signal),
		enabled: scope.isReady && Boolean(compute),
		retry: false,
	});
	const items = uniqueBillingItems(
		subscriptions.data?.pages.flatMap((page) => page.items ?? []) ?? [],
		(item) => item.subscription_id,
	);
	const availability = reusableInventoryState(reusable.error, reusable.data);
	const listBlocked = shouldBlockQueryError(subscriptions.error, subscriptions.data);
	const listReady = Boolean(compute) && !subscriptions.isPending && !listBlocked;
	const endedCount = items.filter(isHistoricalAccountSubscription).length;
	const ordered = sortLoadedSubscriptions(items);
	const visible = showHistory
		? ordered
		: ordered.filter((item) => !isHistoricalAccountSubscription(item));
	const deploymentsById = new Map(
		(inventory.data ?? []).map((deployment) => [deployment.resource.id.toLowerCase(), deployment]),
	);
	const tilesByAgentId = new Map(
		tiles
			.filter((tile) => tile.source === "on-clawdi")
			.map((tile) => [tile.id.toLowerCase(), tile] as const),
	);
	const reusableIds = new Set((reusable.data ?? []).map((item) => item.subscription_id));
	const hasRows = items.length > 0 || subscriptions.hasNextPage;
	return (
		<SettingsShell scroll={false}>
			<NativeList
				data={listReady && availability === "ready" ? visible : []}
				keyExtractor={(item) => item.subscription_id}
				refreshing={subscriptions.isRefetching || reusable.isRefetching || plans.isRefetching}
				onRefresh={() => {
					void subscriptions.refetch();
					void reusable.refetch();
					void plans.refetch();
				}}
				hasMore={subscriptions.hasNextPage && !subscriptions.isFetchNextPageError}
				loadingMore={subscriptions.isFetching}
				onLoadMore={() => void subscriptions.fetchNextPage()}
				header={
					<WebView recipe={billingPageStackClass}>
						<SettingsPanelHeader
							title={t("billingParity.compute")}
							description={t("billingParity.computeDescription")}
						/>
						<SettingsSection
							title={t("billingParity.subscriptions")}
							description={t("billingParity.subscriptionsDescription")}
						/>
						<StoreComputeBillingSection />
						{listReady && availability === "ready" && hasRows && (endedCount || showHistory) ? (
							<AppView className="items-end">
								<Button
									variant="ghost"
									size="sm"
									accessibilityState={{ selected: showHistory }}
									onPress={() => setShowHistory((current) => !current)}
								>
									<Icon as={RotateCcwClock} />
									<Text>{showHistory ? copy.hideHistory : copy.showHistory(endedCount)}</Text>
								</Button>
							</AppView>
						) : null}
					</WebView>
				}
				empty={
					!compute ? (
						<EmptyState variant="inset" title={OVERVIEW_COPY.cloudInventoryError} />
					) : subscriptions.isPending ? (
						<RouteLoadingSkeleton />
					) : listBlocked ? (
						<ApiErrorPanel
							normalizer={billingErrorNormalizer}
							title={BILLING_ERROR_TITLES.loadSubscriptions}
							error={subscriptions.error}
							onRetry={() => void subscriptions.refetch()}
						/>
					) : availability === "loading" ? (
						<RouteLoadingSkeleton />
					) : availability === "error" ? (
						<ApiErrorPanel
							normalizer={billingErrorNormalizer}
							title={BILLING_ERROR_TITLES.loadSubscriptionAvailability}
							error={reusable.error}
							onRetry={() => void reusable.refetch()}
						/>
					) : hasRows ? (
						<EmptyState
							variant="inset"
							title={copy.noCurrentSubscriptions}
							description={endedCount ? copy.endedHidden : copy.loadMoreToFind}
						/>
					) : (
						<EmptyState
							variant="inset"
							title={t("billingParity.emptySubscriptions")}
							description={t("billingParity.emptySubscriptionsDescription")}
						/>
					)
				}
				renderItem={({ item }) => {
					const deployment = item.deployment_id
						? deploymentsById.get(item.deployment_id.toLowerCase())
						: undefined;
					return (
						<SubscriptionRow
							item={item}
							deployment={deployment}
							agentTile={
								deployment ? tilesByAgentId.get(deployment.agent_id.toLowerCase()) : undefined
							}
							reusableSubscriptionIds={reusableIds}
							reusableInventoryUncertain={reusable.isFetching || reusable.error != null}
						/>
					);
				}}
				footer={
					<WebView recipe={billingPageStackClass}>
						{subscriptions.isFetchingNextPage ? <RouteLoadingSkeleton /> : null}
						{subscriptions.isFetchNextPageError ? (
							<ApiErrorPanel
								normalizer={billingErrorNormalizer}
								title={BILLING_ERROR_TITLES.loadMoreSubscriptions}
								error={subscriptions.error}
								onRetry={() => void subscriptions.fetchNextPage()}
							/>
						) : null}
						{compute ? (
							plans.isPending ? (
								<RouteLoadingSkeleton />
							) : shouldBlockQueryError(plans.error, plans.data) ? (
								<SettingsSection
									title={t("billingParity.plans")}
									description={t("billingParity.plansDescription")}
								>
									<ApiErrorPanel
										normalizer={billingErrorNormalizer}
										title={BILLING_ERROR_TITLES.loadPlans}
										error={plans.error}
										onRetry={() => void plans.refetch()}
									/>
								</SettingsSection>
							) : (
								<PlanComparison plans={plans.data ?? []} />
							)
						) : null}
						{creditsNotice ? (
							<WebText recipe={transactionsSectionClasses.description}>{t(creditsNotice)}</WebText>
						) : null}
					</WebView>
				}
			/>
		</SettingsShell>
	);
}
