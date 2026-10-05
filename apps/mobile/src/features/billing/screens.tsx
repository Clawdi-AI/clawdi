import { billingPageClass, transactionsSectionClasses } from "@clawdi/shared/ui";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useI18n } from "../../i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "../../platform/account-lifecycle";
import { useMobileApi } from "../../providers/api-provider";
import { ApiErrorPanel } from "../../ui/api-error-panel";
import { ClerkAction as DetailAction } from "../../ui/auth/clerk-form";
import { ComputeSubscriptionCard } from "../../ui/billing/compute-subscription-card";
import { PlanComparison } from "../../ui/billing/plan-comparison";
import { BalanceCard, TransactionRow, WalletSettingsSections } from "../../ui/billing/wallet";
import { Button } from "../../ui/button";
import { EmptyState } from "../../ui/empty-state";
import { ErrorState, LoadingScreen } from "../../ui/feedback";
import { DetailRow } from "../../ui/metadata-row";
import { AppScrollView, AppText, AppView } from "../../ui/primitives";
import { ReadScreen } from "../../ui/read-screen";
import { RouteLoadingSkeleton } from "../../ui/route-loading-skeleton";
import { SettingsPanelHeader, SettingsSection } from "../../ui/settings/section";
import { SettingsShell } from "../../ui/settings/shell";
import { Text } from "../../ui/text";
import { WebText, WebView, webView } from "../../ui/web-layout";
import { BackButton, formatDate } from "../cloud-inventory";
import { ResourceError } from "../resource-error";
import {
	nextBillingCursor,
	type Subscription,
	subscriptionPrice,
	uniqueBillingItems,
	validSubscriptionId,
} from "./helpers";

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
function SubscriptionRecovery({ item }: { item: Subscription }) {
	const t = useI18n();
	const recovery = computeSubscriptionRecoveryPresentation(
		item,
		{ label: item.status, tone: "neutral" },
		{
			updating: t("billing.updating"),
			processing: t("billing.processing"),
			unpaid: t("billing.unpaid"),
			actionRequired: t("billing.actionRequired"),
			pastDue: t("billing.pastDue"),
			paymentProcessing: t("billing.paymentProcessing"),
			attention: t("billing.attention"),
			awaitingPayment: t("billing.awaitingPayment"),
			support: t("billing.support"),
			ended: t("billing.ended"),
			paymentAttention: t("billing.paymentAttention"),
		},
	);
	return (
		<AppView className="gap-2">
			{recovery.status.label !== item.status ? (
				<AppText
					accessibilityRole={recovery.hasPaymentIssue ? "alert" : undefined}
					className="text-foreground"
				>
					{recovery.status.label}
				</AppText>
			) : null}
			{recovery.schedule?.at ? (
				<DetailRow
					label={t("billing.retries")}
					value={formatDate(recovery.schedule.at) ?? t("billing.unknown")}
				/>
			) : recovery.schedule?.fallback ? (
				<AppText className="text-muted-foreground">{recovery.schedule.fallback}</AppText>
			) : null}
			{item.cancel_at_period_end ? (
				<AppText className="text-muted-foreground">{t("billing.cancellation")}</AppText>
			) : null}
			{item.pending_plan_slug ? (
				<DetailRow label={t("billing.pendingPlan")} value={item.pending_plan_slug} />
			) : null}
			{recovery.recoveryTarget ? (
				<AppText className="text-muted-foreground">{t("billing.providerRecovery")}</AppText>
			) : null}
		</AppView>
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
				<AppView className="gap-4 p-6">
					<BackButton />
					<AppText>{t("billing.unavailable")}</AppText>
				</AppView>
			</ReadScreen>
		);
	if (!validId)
		return (
			<ReadScreen>
				<AppView className="gap-4 p-6">
					<BackButton />
					<ResourceError missing />
				</AppView>
			</ReadScreen>
		);
	if (query.isPending) return <LoadingScreen />;
	return (
		<ReadScreen>
			<AppScrollView contentContainerClassName={webView(billingPageClass)}>
				<BackButton />
				<AppText className="text-lg font-semibold text-foreground">{t("billing.details")}</AppText>
				<DetailAction
					disabled={query.isFetching}
					label={t("inventory.refresh")}
					onPress={() => {
						void query.refetch();
					}}
				/>
				{query.isError ? (
					<ErrorState onRetry={query.isFetching ? undefined : () => void query.refetch()} />
				) : null}
				{item ? (
					<AppView className={webView(transactionsSectionClasses.section)}>
						<ComputeSubscriptionCard item={item} />
						<DetailRow label={t("billing.agent")} value={item.agent_name ?? t("billing.unknown")} />
						<DetailRow label={t("billing.plan")} value={item.plan_slug} />
						<DetailRow label={t("billing.status")} value={item.status} />
						<SubscriptionRecovery item={item} />
						<DetailRow
							label={t("billing.price")}
							value={subscriptionPrice(item) ?? t("billing.unknown")}
						/>
						<DetailRow label={t("billing.term")} value={String(item.billing_term_months)} />
						<DetailRow
							label={t("billing.source")}
							value={
								item.subscription_kind === "included_basic"
									? t("billing.included")
									: item.funding_source === "wallet"
										? t("billing.wallet")
										: item.funding_source === "stripe"
											? t("billing.stripe")
											: t("billing.unknown")
							}
						/>
						<DetailRow
							label={t("billing.periodEnd")}
							value={formatDate(item.current_period_end) ?? t("billing.unknown")}
						/>
						{item.funding_source === "wallet" ? (
							<AppText>{t("billing.walletNotice")}</AppText>
						) : null}
						<AppText className="text-muted-foreground">{t("billing.management")}</AppText>
						{item.deployment_id ? (
							<DetailAction
								label={t("billing.deployment")}
								onPress={() => {
									if (scope.isCurrent() && !scope.signal.aborted && item.deployment_id)
										router.push(`/deployments/${encodeURIComponent(item.deployment_id)}`);
								}}
							/>
						) : null}
					</AppView>
				) : !query.isError ? (
					query.hasNextPage ? (
						<>
							<AppText>{t("billing.moreToSearch")}</AppText>
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

import { computeSubscriptionRecoveryPresentation } from "@clawdi/shared/api";
