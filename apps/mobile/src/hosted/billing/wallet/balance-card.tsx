import type { DeployComponents } from "@clawdi/shared/api";
import { balanceCardClasses as balance } from "@clawdi/shared/ui";
import { formatUsdExact, isLowBalance } from "@clawdi/shared/view";
import { Coins, CreditCard, TriangleAlert } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { WebText, WebView, webView } from "@/components/ui/web-layout";
import { useI18n } from "@/lib/i18n";

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
