import type { DeployComponents } from "@clawdi/shared/api";
import {
	autoReloadCardClasses,
	balanceCardClasses as balance,
	paymentMethodsSectionClasses,
	transactionsSectionClasses as transactions,
	x402CardClasses,
} from "@clawdi/shared/ui";
import {
	formatShortDate,
	formatUsdExact,
	isLowBalance,
	paymentMethodPresentation,
	paymentMethodsCopy,
	transactionComputeDetails,
	transactionDocumentAction,
	transactionKindLabel,
	transactionPaymentSourceLabel,
	transactionSignedAmount,
	transactionStatusLabel,
	transactionStatusTone,
} from "@clawdi/shared/view";
import { useQuery } from "@tanstack/react-query";
import { openBrowserAsync } from "expo-web-browser";
import { Coins, CreditCard, ExternalLink, Link2, Pencil, TriangleAlert } from "lucide-react-native";
import { useAuthAction } from "../../auth/use-auth-action";
import type { Transaction } from "../../features/billing/helpers";
import { useI18n } from "../../i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "../../platform/account-lifecycle";
import { useForegroundLease } from "../../platform/use-foreground-lease";
import { useMobileApi } from "../../providers/api-provider";
import { ApiErrorPanel } from "../api-error-panel";
import { Badge } from "../badge";
import { Button } from "../button";
import { Card, CardContent } from "../card";
import { Icon } from "../icon";
import { Input, Label } from "../input";
import { SettingsSection } from "../settings/section";
import { Skeleton } from "../skeleton";
import { StatusBadge } from "../status-badge";
import { Switch } from "../switch";
import { Text } from "../text";
import { WebText, WebView, webView } from "../web-layout";

type Wallet = DeployComponents["schemas"]["V2WalletResponse"];
export function BalanceCard({ wallet }: { wallet: Pick<Wallet, "balance_usd"> }) {
	const t = useI18n();
	const low = isLowBalance(wallet.balance_usd);
	return (
		<Card>
			<CardContent className={webView(balance.layout)}>
				<WebView recipe={balance.copy}>
					<WebView recipe={balance.label} className="flex-row">
						<Icon as={Coins} />
						<Text>{t("billingParity.walletBalance")}</Text>
					</WebView>
					<WebText recipe={low ? balance.negativeBalance : balance.balance}>
						{formatUsdExact(wallet.balance_usd)}
					</WebText>
					<WebText recipe={balance.meta}>{t("billingParity.walletExplanation")}</WebText>
					{low ? (
						<WebView recipe={balance.warning} className="flex-row">
							<Icon as={TriangleAlert} />
							<Text>{t("billingParity.lowBalance")}</Text>
						</WebView>
					) : null}
				</WebView>
				<WebView recipe={balance.actions}>
					<Button disabled>
						<Icon as={CreditCard} />
						<Text>{t("billingParity.topUp")}</Text>
					</Button>
				</WebView>
			</CardContent>
		</Card>
	);
}
export function TransactionRow({ item }: { item: Transaction }) {
	const t = useI18n();
	const scope = useAccountScope();
	const action = useAuthAction(scope.identity);
	const capture = useForegroundLease();
	const document = transactionDocumentAction(item);
	let documentUrl: string | null = null;
	try {
		const url = document ? new URL(document.url) : null;
		if (url?.protocol === "https:" && !url.username && !url.password) documentUrl = url.href;
	} catch {
		// Malformed document links remain visible but cannot open a browser.
	}
	const openDocument = () =>
		void action.run(async (current) => {
			if (!documentUrl || !current() || !scope.isCurrent() || !capture()()) return;
			await openBrowserAsync(documentUrl);
		});
	return (
		<WebView recipe={transactions.mobileRow} className="flex-row">
			<WebView recipe={transactions.mobileCopy} className="flex-1">
				<WebText recipe={transactions.label}>{transactionKindLabel(item.kind)}</WebText>
				{transactionComputeDetails(item).map((detail) => (
					<WebText key={detail} recipe={transactions.reference}>
						{detail}
					</WebText>
				))}
				<WebView recipe={transactions.mobileHeading} className="flex-row">
					<Badge variant="outline">
						<Text>{transactionPaymentSourceLabel(item.funding)}</Text>
					</Badge>
					<StatusBadge status={transactionStatusTone(item.status)}>
						<Text>{transactionStatusLabel(item.status)}</Text>
					</StatusBadge>
					<WebText recipe={transactions.description}>{formatShortDate(item.occurred_at)}</WebText>
				</WebView>
				{document ? (
					<Button
						variant="link"
						size="xs"
						className={webView(transactions.inlineAction)}
						disabled={!documentUrl || action.busy}
						onPress={openDocument}
					>
						<Text>{document.label}</Text>
						<Icon as={ExternalLink} />
					</Button>
				) : (
					<WebText recipe={transactions.muted}>—</WebText>
				)}
				{action.error ? (
					<WebText accessibilityRole="alert" recipe={transactions.description}>
						{t("account.actionFailed")}
					</WebText>
				) : null}
			</WebView>
			<WebText
				recipe={transactions.amount}
				className={item.direction === "credit" ? "text-success-muted-foreground" : undefined}
			>
				{transactionSignedAmount(item)}
			</WebText>
		</WebView>
	);
}

/** Native payments remain outside this read-only presentation. */
export function WalletSettingsSections({
	wallet,
}: {
	wallet: Pick<
		Wallet,
		| "auto_reload_enabled"
		| "auto_reload_threshold_usd"
		| "auto_reload_amount_cents"
		| "auto_reload_monthly_cap_cents"
		| "x402_enabled"
	>;
}) {
	const t = useI18n();
	const { compute } = useMobileApi();
	const scope = useAccountScope();
	const read = useAccountRead();
	const methods = useQuery({
		queryKey: accountQueryKey(scope, "billing-payment-methods"),
		enabled: scope.isReady && Boolean(compute),
		retry: false,
		queryFn: ({ signal }) =>
			read((lease) => {
				if (!compute) throw new Error("Compute unavailable");
				return compute.getWalletPaymentMethods(lease);
			}, signal),
	});
	return (
		<>
			<SettingsSection
				title={t("billingParity.paymentMethods")}
				description={t("billingParity.paymentMethodsDescription")}
				actions={
					<Button variant="outline" size="sm" disabled>
						<Icon as={Pencil} />
						<Text>{t("billingParity.edit")}</Text>
					</Button>
				}
			>
				<WebView recipe={paymentMethodsSectionClasses.body}>
					{methods.isPending ? (
						<Skeleton className={webView(paymentMethodsSectionClasses.loading)} />
					) : methods.isError ? (
						<ApiErrorPanel
							error={methods.error}
							title={paymentMethodsCopy.error}
							onRetry={() => void methods.refetch()}
						/>
					) : methods.data?.items.length ? (
						<WebView recipe={paymentMethodsSectionClasses.list}>
							{methods.data.items.map((method) => {
								const copy = paymentMethodPresentation(method);
								return (
									<WebView
										key={method.id}
										recipe={paymentMethodsSectionClasses.item}
										className="flex-row"
									>
										<Icon as={CreditCard} className={webView(paymentMethodsSectionClasses.icon)} />
										<WebView recipe={paymentMethodsSectionClasses.copy}>
											<WebText recipe={paymentMethodsSectionClasses.title}>{copy.title}</WebText>
											<WebText recipe={paymentMethodsSectionClasses.hint}>{copy.expires}</WebText>
										</WebView>
										{method.is_default ? (
											<Badge variant="outline">
												<Text>{paymentMethodsCopy.billingDefault}</Text>
											</Badge>
										) : null}
										{method.is_auto_reload ? (
											<Badge variant="outline">
												<Text>{paymentMethodsCopy.autoReload}</Text>
											</Badge>
										) : null}
									</WebView>
								);
							})}
						</WebView>
					) : (
						<WebText recipe={paymentMethodsSectionClasses.empty}>
							{paymentMethodsCopy.empty}
						</WebText>
					)}
					{methods.data?.has_more ? (
						<WebText recipe={paymentMethodsSectionClasses.hint}>{paymentMethodsCopy.more}</WebText>
					) : null}
					<WebText recipe={paymentMethodsSectionClasses.hint}>
						{t("billingParity.autoReloadCardHint")}
					</WebText>
				</WebView>
			</SettingsSection>
			<SettingsSection
				title={t("billingParity.autoReload")}
				description={t("billingParity.autoReloadDescription")}
				actions={
					<Switch
						checked={wallet.auto_reload_enabled}
						disabled
						accessibilityLabel={t("billingParity.autoReload")}
					/>
				}
			>
				{wallet.auto_reload_enabled ? (
					<WebView recipe={autoReloadCardClasses.form}>
						{[
							{ key: "autoReloadThreshold" as const, value: wallet.auto_reload_threshold_usd },
							{
								key: "autoReloadAmount" as const,
								value: String(wallet.auto_reload_amount_cents / 100),
							},
							...(wallet.auto_reload_monthly_cap_cents > 0
								? [
										{
											key: "autoReloadMonthlyLimit" as const,
											value: String(wallet.auto_reload_monthly_cap_cents / 100),
										},
									]
								: []),
						].map((field) => (
							<WebView key={field.key} recipe={autoReloadCardClasses.field}>
								<Label>{t(`billingParity.${field.key}`)}</Label>
								<Input
									value={field.value}
									editable={false}
									className={webView(autoReloadCardClasses.input)}
								/>
							</WebView>
						))}
					</WebView>
				) : null}
			</SettingsSection>
			<SettingsSection
				title={
					<WebView recipe={x402CardClasses.title}>
						<WebView recipe={x402CardClasses.label}>
							<Icon as={Link2} className={x402CardClasses.icon} />
							<Text>{t("billingParity.usdc")}</Text>
						</WebView>
						<Badge variant="secondary">
							<Text>{t("billingParity.comingSoon")}</Text>
						</Badge>
					</WebView>
				}
				description={
					wallet.x402_enabled ? t("billing.noStore") : t("billingParity.usdcUnavailable")
				}
			/>
		</>
	);
}
