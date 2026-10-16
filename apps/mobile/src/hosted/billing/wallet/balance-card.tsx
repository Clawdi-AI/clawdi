import { balanceCardClasses as balance } from "@clawdi/shared/ui";
import { billingCopy, formatUsdExact, isLowBalance, lowBalanceWarning } from "@clawdi/shared/view";
import Coins from "lucide-react-native/icons/coins";
import CreditCard from "lucide-react-native/icons/credit-card";
import TriangleAlert from "lucide-react-native/icons/triangle-alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { WebText, WebView, webView } from "@/components/ui/web-layout";
import type { Wallet } from "@/hosted/billing/format";
import { AddCreditsAction, CheckPendingPurchasesAction } from "@/hosted/billing/store/add-credits";
import { useI18n } from "@/lib/i18n";
import { useStoreSurfaces } from "@/platform/store/store-provider";

/** Web's Top up: the store Paywall where the build sells top-ups, otherwise disabled. */
export function WalletTopUpAction({ size }: { size?: "default" | "sm" }) {
	const surfaces = useStoreSurfaces();
	return surfaces.addCredits ? (
		<AddCreditsAction size={size} />
	) : (
		<Button size={size} disabled>
			<Icon as={CreditCard} />
			<Text>{billingCopy.topUp}</Text>
		</Button>
	);
}

export function BalanceCard({
	wallet,
	hasWalletCompute = false,
}: {
	wallet: Pick<Wallet, "balance_usd">;
	hasWalletCompute?: boolean;
}) {
	const t = useI18n();
	const surfaces = useStoreSurfaces();
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
					<WebText recipe={balance.meta}>
						{t(
							surfaces.cardBilling ? "billingParity.walletExplanation" : "store.walletExplanation",
						)}
					</WebText>
					{low ? (
						<WebView recipe={balance.warning} className="flex-row">
							<Icon as={TriangleAlert} />
							<Text>{lowBalanceWarning(hasWalletCompute)}</Text>
						</WebView>
					) : null}
				</WebView>
				<WebView recipe={balance.actions}>
					<WalletTopUpAction />
					{surfaces.addCredits && !surfaces.cardBilling ? <CheckPendingPurchasesAction /> : null}
				</WebView>
			</CardContent>
		</Card>
	);
}
