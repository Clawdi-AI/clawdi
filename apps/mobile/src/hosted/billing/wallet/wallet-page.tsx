import { billingPageClass, transactionsSectionClasses } from "@clawdi/shared/ui";
import { transactionsCountLabel } from "@clawdi/shared/view";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { EmptyState } from "@/components/empty-state";
import { RouteLoadingSkeleton } from "@/components/route-loading-skeleton";
import { SettingsPanelHeader, SettingsSection } from "@/components/settings/settings-panel-header";
import { SettingsShell } from "@/components/settings/shell";
import { NativeList } from "@/components/ui/native-list";
import { WebText, WebView } from "@/components/ui/web-layout";
import { nextBillingCursor, uniqueBillingItems } from "@/hosted/billing/format";
import { useCreditsNotice, useStoreRecoveryRefresh } from "@/hosted/billing/store/add-credits";
import { BalanceCard } from "@/hosted/billing/wallet/balance-card";
import { TransactionRow } from "@/hosted/billing/wallet/transactions-section";
import { WalletSettingsSections } from "@/hosted/billing/wallet/wallet-sections";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useStoreSurfaces } from "@/platform/store/store-provider";

function initialCursor(): string | undefined {
	return undefined;
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
	const surfaces = useStoreSurfaces();
	const creditsNotice = useCreditsNotice();
	useStoreRecoveryRefresh();
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
		<SettingsShell scroll={false}>
			<NativeList
				data={wallet.data && !wallet.isError ? rows : []}
				keyExtractor={(item) => item.id}
				renderItem={({ item }) => <TransactionRow item={item} />}
				refreshing={wallet.isRefetching || transactions.isRefetching}
				onRefresh={() => {
					void wallet.refetch();
					void transactions.refetch();
				}}
				hasMore={transactions.hasNextPage}
				loadingMore={transactions.isFetching}
				onLoadMore={() => void transactions.fetchNextPage()}
				header={
					<WebView recipe={billingPageClass}>
						<SettingsPanelHeader
							title={t("billingParity.wallet")}
							description={t(
								surfaces.cardBilling
									? "billingParity.walletDescription"
									: "store.walletDescription",
							)}
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
								/>
							</>
						)}
					</WebView>
				}
				empty={
					wallet.data && !wallet.isError ? (
						transactions.isPending ? (
							<RouteLoadingSkeleton />
						) : transactions.isError ? (
							<ApiErrorPanel
								error={transactions.error}
								onRetry={() => void transactions.refetch()}
							/>
						) : (
							<EmptyState
								variant="inset"
								title={t("billingParity.emptyTransactions")}
								description={t("billingParity.emptyTransactionsDescription")}
							/>
						)
					) : null
				}
				footer={
					<WebView recipe={transactionsSectionClasses.section}>
						{transactions.isFetchingNextPage ? <RouteLoadingSkeleton /> : null}
						{transactions.isError && transactions.data ? (
							<ApiErrorPanel
								error={transactions.error}
								onRetry={() => void transactions.refetch()}
							/>
						) : null}
						{rows.length ? (
							<WebText recipe={transactionsSectionClasses.description}>
								{transactionsCountLabel(rows.length)}
							</WebText>
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
