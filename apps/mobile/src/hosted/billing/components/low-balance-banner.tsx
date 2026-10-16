import { lowBalanceBannerView } from "@clawdi/shared/view";
import TriangleAlert from "lucide-react-native/icons/triangle-alert";
import { Alert } from "@/components/ui/alert";
import { Text } from "@/components/ui/text";
import { AppView } from "@/components/ui/view";
import type { Wallet } from "@/hosted/billing/format";
import { WalletTopUpAction } from "@/hosted/billing/wallet/balance-card";
import { useStoreSurfaces } from "@/platform/store/store-provider";

/**
 * Web's low-balance / payment-attention banner. Store builds have no auto-reload, so only a
 * low balance shows there. Auto-reload is read-only in the app, so the action is Top up.
 */
export function LowBalanceBanner({
	wallet,
	hasWalletCompute,
}: {
	wallet: Pick<Wallet, "balance_usd" | "auto_reload_action">;
	hasWalletCompute: boolean;
}) {
	const { cardBilling } = useStoreSurfaces();
	const view = lowBalanceBannerView(wallet, { hasWalletCompute, cardBilling });
	if (!view) return null;
	return (
		<Alert variant={view.tone} icon={TriangleAlert} title={view.title}>
			<AppView className="items-start gap-3">
				<Text>{view.body}</Text>
				<WalletTopUpAction size="sm" />
			</AppView>
		</Alert>
	);
}
