import { billingPageClass, transactionsSectionClasses } from "@clawdi/shared/ui";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { EmptyState } from "@/components/empty-state";
import { RouteLoadingSkeleton } from "@/components/route-loading-skeleton";
import { SettingsPanelHeader, SettingsSection } from "@/components/settings/settings-panel-header";
import { SettingsShell } from "@/components/settings/shell";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { WebText, WebView } from "@/components/ui/web-layout";
import { uniqueBillingItems } from "@/hosted/billing/format";
import { useSubscriptions } from "@/hosted/billing/hooks";
import { ComputeSubscriptionCard } from "@/hosted/billing/subscription/compute-subscription-card";
import { PlanComparison } from "@/hosted/billing/subscription/plan-comparison";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
export function BillingScreen() {
	const scope = useAccountScope();
	return <BillingView key={`${scope.accountKey}:${scope.generation}`} />;
}
function BillingView() {
	const t = useI18n();
	const scope = useAccountScope();
	const { compute } = useMobileApi();
	const read = useAccountRead();
	const router = useRouter();
	const subscriptions = useSubscriptions();
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
	return (
		<SettingsShell active="compute" back>
			<WebView recipe={billingPageClass}>
				<SettingsPanelHeader
					title={t("billingParity.compute")}
					description={t("billingParity.computeDescription")}
				/>
				{!compute ? (
					<EmptyState variant="inset" title={t("billing.unavailable")} />
				) : (
					<>
						<SettingsSection
							title={t("billingParity.subscriptions")}
							description={t("billingParity.subscriptionsDescription")}
						>
							{subscriptions.isPending ? (
								<RouteLoadingSkeleton />
							) : subscriptions.isError && !subscriptions.data ? (
								<ApiErrorPanel
									error={subscriptions.error}
									onRetry={() => void subscriptions.refetch()}
								/>
							) : items.length ? (
								<WebView recipe={transactionsSectionClasses.section}>
									{items.map((item) => (
										<ComputeSubscriptionCard
											key={item.subscription_id}
											item={item}
											actions={
												<Button
													variant="outline"
													size="sm"
													onPress={() => {
														if (scope.isCurrent() && !scope.signal.aborted)
															router.push(
																`/settings/compute/${encodeURIComponent(item.subscription_id)}`,
															);
													}}
												>
													<Text>{t("inventory.viewDetails")}</Text>
												</Button>
											}
										/>
									))}
								</WebView>
							) : (
								<EmptyState
									variant="inset"
									title={t("billingParity.emptySubscriptions")}
									description={t("billingParity.emptySubscriptionsDescription")}
								/>
							)}
							{subscriptions.hasNextPage ? (
								<Button
									variant="outline"
									disabled={subscriptions.isFetching}
									onPress={() => void subscriptions.fetchNextPage()}
								>
									<Text>{t("inventory.loadMore")}</Text>
								</Button>
							) : null}
							{subscriptions.isError && subscriptions.data ? (
								<ApiErrorPanel
									error={subscriptions.error}
									onRetry={() => void subscriptions.refetch()}
								/>
							) : null}
						</SettingsSection>
						{plans.isPending ? (
							<RouteLoadingSkeleton />
						) : plans.isError ? (
							<ApiErrorPanel error={plans.error} onRetry={() => void plans.refetch()} />
						) : (
							<PlanComparison plans={plans.data ?? []} />
						)}
						<WebText recipe={transactionsSectionClasses.description}>
							{t("billing.noStore")}
						</WebText>
					</>
				)}
			</WebView>
		</SettingsShell>
	);
}
