import { billingPageClass, transactionsSectionClasses } from "@clawdi/shared/ui";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { EmptyState } from "@/components/empty-state";
import { RouteLoadingSkeleton } from "@/components/route-loading-skeleton";
import { SettingsPanelHeader, SettingsSection } from "@/components/settings/settings-panel-header";
import { SettingsShell } from "@/components/settings/shell";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { WebText, WebView } from "@/components/ui/web-layout";
import { nextBillingCursor, uniqueBillingItems } from "@/hosted/billing/format";
import { BalanceCard } from "@/hosted/billing/wallet/balance-card";
import { TransactionRow } from "@/hosted/billing/wallet/transactions-section";
import { WalletSettingsSections } from "@/hosted/billing/wallet/wallet-sections";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";

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
