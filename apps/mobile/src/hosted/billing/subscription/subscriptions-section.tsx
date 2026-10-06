import { billingPageClass, transactionsSectionClasses } from "@clawdi/shared/ui";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { useMobileApi } from "@/components/api-provider";
import { ClerkAction as DetailAction } from "@/components/auth/clerk-form";
import { EmptyState } from "@/components/empty-state";
import { ResourceError } from "@/components/resource-error";
import { RouteLoadingSkeleton } from "@/components/route-loading-skeleton";
import { SettingsBackButton } from "@/components/settings/back-button";
import { SettingsPanelHeader, SettingsSection } from "@/components/settings/settings-panel-header";
import { SettingsShell } from "@/components/settings/shell";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { AppScrollView, AppView } from "@/components/ui/view";
import { WebText, WebView, webView } from "@/components/ui/web-layout";
import {
	nextBillingCursor,
	uniqueBillingItems,
	validSubscriptionId,
} from "@/hosted/billing/format";
import { ComputeSubscriptionCard } from "@/hosted/billing/subscription/compute-subscription-card";
import { PlanComparison } from "@/hosted/billing/subscription/plan-comparison";
import { SubscriptionDetails } from "@/hosted/billing/subscription/subscription-details";
import {
	BalanceCard,
	TransactionRow,
	WalletSettingsSections,
} from "@/hosted/billing/wallet/wallet-sections";
import { useI18n } from "@/lib/i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { ReadScreen } from "@/platform/safe-area-screen";

function initialCursor(): string | undefined {
	return undefined;
}

function useSubscriptions(enabled = true) {
	const { compute } = useMobileApi();
	const scope = useAccountScope();
	const read = useAccountRead();
	return useInfiniteQuery({
		queryKey: accountQueryKey(scope, "billing-subscriptions"),
		initialPageParam: initialCursor(),
		queryFn: ({ signal, pageParam }) =>
			read((s) => {
				if (!compute) throw new Error("Compute API unavailable");
				return compute.getSubscriptions({ limit: 25, cursor: pageParam }, s);
			}, signal),
		getNextPageParam: nextBillingCursor,
		enabled: scope.isReady && Boolean(compute) && enabled,
		retry: false,
	});
}

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
																`/billing/subscriptions/${encodeURIComponent(item.subscription_id)}`,
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
export function WalletScreen() {
	const scope = useAccountScope();
	return <WalletView key={`${scope.accountKey}:${scope.generation}`} />;
}
function WalletView() {
	const t = useI18n();
	const { compute } = useMobileApi();
	const scope = useAccountScope();
	const read = useAccountRead();
	const wallet = useQuery({
		queryKey: accountQueryKey(scope, "billing-wallet"),
		queryFn: ({ signal }) =>
			read((s) => {
				if (!compute) throw new Error("Compute API unavailable");
				return compute.getWallet(s);
			}, signal),
		enabled: scope.isReady && Boolean(compute),
		retry: false,
	});
	const transactions = useInfiniteQuery({
		queryKey: accountQueryKey(scope, "billing-transactions"),
		initialPageParam: initialCursor(),
		queryFn: ({ signal, pageParam }) =>
			read((s) => {
				if (!compute) throw new Error("Compute API unavailable");
				return compute.getWalletTransactions({ limit: 25, cursor: pageParam }, s);
			}, signal),
		getNextPageParam: nextBillingCursor,
		enabled: scope.isReady && Boolean(compute),
		retry: false,
	});
	const rows = uniqueBillingItems(
		transactions.data?.pages.flatMap((page) => page.items) ?? [],
		(item) => item.id,
	);
	return (
		<SettingsShell active="wallet" back>
			<WebView recipe={billingPageClass}>
				<SettingsPanelHeader
					title={t("billingParity.wallet")}
					description={t("billingParity.walletDescription")}
				/>
				{!compute ? (
					<EmptyState variant="inset" title={t("billing.unavailable")} />
				) : wallet.isPending ? (
					<RouteLoadingSkeleton />
				) : wallet.isError || !wallet.data ? (
					<ApiErrorPanel error={wallet.error} onRetry={() => void wallet.refetch()} />
				) : (
					<>
						<BalanceCard wallet={wallet.data} />
						<WalletSettingsSections wallet={wallet.data} />
						<SettingsSection
							title={t("billingParity.transactions")}
							description={t("billingParity.transactionsDescription")}
						>
							<WebView recipe={transactionsSectionClasses.section}>
								{transactions.isPending ? (
									<RouteLoadingSkeleton />
								) : transactions.isError && !transactions.data ? (
									<ApiErrorPanel
										error={transactions.error}
										onRetry={() => void transactions.refetch()}
									/>
								) : rows.length ? (
									<WebView recipe={transactionsSectionClasses.mobileRows}>
										{rows.map((item) => (
											<TransactionRow key={item.id} item={item} />
										))}
									</WebView>
								) : (
									<EmptyState
										variant="inset"
										title={t("billingParity.emptyTransactions")}
										description={t("billingParity.emptyTransactionsDescription")}
									/>
								)}
								{rows.length ? (
									<WebText recipe={transactionsSectionClasses.description}>
										{t("billingParity.transactionsCount").replace("{count}", String(rows.length))}
									</WebText>
								) : null}
								{transactions.hasNextPage ? (
									<Button
										variant="outline"
										disabled={transactions.isFetching}
										onPress={() => void transactions.fetchNextPage()}
									>
										<Text>{t("inventory.loadMore")}</Text>
									</Button>
								) : null}
								{transactions.isError && transactions.data ? (
									<ApiErrorPanel
										error={transactions.error}
										onRetry={() => void transactions.refetch()}
									/>
								) : null}
							</WebView>
						</SettingsSection>
						<WebText recipe={transactionsSectionClasses.description}>
							{t("billing.noStore")}
						</WebText>
					</>
				)}
			</WebView>
		</SettingsShell>
	);
}

export function SubscriptionDetailScreen({
	subscriptionId,
}: {
	subscriptionId: string | undefined;
}) {
	const t = useI18n();
	const router = useRouter();
	const scope = useAccountScope();
	const { compute } = useMobileApi();
	const validId = validSubscriptionId(subscriptionId);
	const query = useSubscriptions(validId);
	const item = query.data?.pages
		.flatMap((page) => page.items ?? [])
		.find((candidate) => candidate.subscription_id === subscriptionId);
	if (!compute)
		return (
			<ReadScreen>
				<AppView className={webView(billingPageClass)}>
					<SettingsBackButton />
					<SettingsPanelHeader title={t("billing.details")} />
					<EmptyState variant="inset" title={t("billing.unavailable")} />
				</AppView>
			</ReadScreen>
		);
	if (!validId)
		return (
			<ReadScreen>
				<AppView className="gap-4 p-6">
					<SettingsBackButton />
					<ResourceError missing />
				</AppView>
			</ReadScreen>
		);
	if (query.isPending)
		return (
			<ReadScreen>
				<RouteLoadingSkeleton />
			</ReadScreen>
		);
	return (
		<ReadScreen>
			<AppScrollView contentContainerClassName={webView(billingPageClass)}>
				<SettingsBackButton />
				<SettingsPanelHeader title={t("billing.details")} />
				<DetailAction
					disabled={query.isFetching}
					label={t("inventory.refresh")}
					onPress={() => {
						void query.refetch();
					}}
				/>
				{query.isError ? (
					<ApiErrorPanel
						error={query.error}
						onRetry={query.isFetching ? undefined : () => void query.refetch()}
					/>
				) : null}
				{item ? (
					<SubscriptionDetails
						item={item}
						onDeployment={() => {
							if (scope.isCurrent() && !scope.signal.aborted && item.deployment_id)
								router.push(`/deployments/${encodeURIComponent(item.deployment_id)}`);
						}}
					/>
				) : !query.isError ? (
					query.hasNextPage ? (
						<>
							<Text>{t("billing.moreToSearch")}</Text>
							<DetailAction
								disabled={query.isFetching}
								label={t("inventory.loadMore")}
								onPress={() => {
									void query.fetchNextPage();
								}}
							/>
						</>
					) : (
						<ResourceError missing />
					)
				) : null}
			</AppScrollView>
		</ReadScreen>
	);
}
