import type { DeployComponents } from "@clawdi/shared/api";
import {
	autoReloadCardClasses,
	paymentMethodsSectionClasses,
	x402CardClasses,
} from "@clawdi/shared/ui";
import { paymentMethodPresentation, paymentMethodsCopy } from "@clawdi/shared/view";
import { useQuery } from "@tanstack/react-query";
import { CreditCard, Link2, Pencil } from "lucide-react-native";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { SettingsSection } from "@/components/settings/settings-panel-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input, Label } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Text } from "@/components/ui/text";
import { WebText, WebView, webView } from "@/components/ui/web-layout";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useStoreSurfaces } from "@/platform/store/store-provider";

type Wallet = DeployComponents["schemas"]["V2WalletResponse"];
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
	// Store builds hide card-only surfaces: saved cards, card setup and auto-reload.
	const { cardBilling, addCredits } = useStoreSurfaces();
	const methods = useQuery({
		queryKey: accountQueryKey(scope, "billing-payment-methods"),
		enabled: cardBilling && scope.isReady && Boolean(compute),
		retry: false,
		queryFn: ({ signal }) =>
			read((lease) => {
				if (!compute) throw new Error("Compute unavailable");
				return compute.getWalletPaymentMethods(lease);
			}, signal),
	});
	return (
		<>
			{cardBilling ? (
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
												<Icon
													as={CreditCard}
													className={webView(paymentMethodsSectionClasses.icon)}
												/>
												<WebView recipe={paymentMethodsSectionClasses.copy}>
													<WebText recipe={paymentMethodsSectionClasses.title}>
														{copy.title}
													</WebText>
													<WebText recipe={paymentMethodsSectionClasses.hint}>
														{copy.expires}
													</WebText>
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
								<WebText recipe={paymentMethodsSectionClasses.hint}>
									{paymentMethodsCopy.more}
								</WebText>
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
				</>
			) : null}
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
					wallet.x402_enabled && !addCredits
						? t("billing.noStore")
						: t("billingParity.usdcUnavailable")
				}
			/>
		</>
	);
}
