import type { DeploymentRead } from "@clawdi/shared/api";
import { computeDunningBannerClasses as styles } from "@clawdi/shared/ui";
import {
	computeDunningCopy,
	computeDunningDescription,
	computeDunningState,
} from "@clawdi/shared/view";
import { router } from "expo-router";
import Info from "lucide-react-native/icons/info";
import TriangleAlert from "lucide-react-native/icons/triangle-alert";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { WebView, webView } from "@/components/ui/web-layout";
import { AddCreditsAction } from "@/hosted/billing/store/add-credits";
import { useI18n } from "@/lib/i18n";
import { storeRecoveryAction } from "@/platform/store/store-policy";
import { useStoreSurfaces } from "@/platform/store/store-provider";

export function ComputeDunningBanner({ deployment }: { deployment: DeploymentRead }) {
	const t = useI18n();
	const surfaces = useStoreSurfaces();
	const state = computeDunningState(deployment);
	if (!state) return null;
	// Wallet top-up recovery opens the Paywall; store builds show card recovery as status only.
	const action = storeRecoveryAction(surfaces, state.recoveryTarget);
	return (
		<Alert
			variant={state.tone === "destructive" ? "destructive" : "default"}
			icon={state.tone === "neutral" ? Info : TriangleAlert}
			title={state.title}
			className={
				state.tone === "destructive"
					? undefined
					: webView(state.tone === "warning" ? styles.warning : styles.neutral)
			}
		>
			<WebView recipe={styles.description}>
				<Text>
					{action === "add_credits"
						? t("store.walletDunning")
						: action === "card_status"
							? t("store.cardDunning")
							: computeDunningDescription(state)}
				</Text>
				{action === "add_credits" ? <AddCreditsAction size="sm" /> : null}
				{state.secondaryTarget === "transactions" ? (
					<Button variant="outline" size="sm" onPress={() => router.push("/settings/wallet")}>
						<Text>{computeDunningCopy.transactions}</Text>
					</Button>
				) : null}
			</WebView>
		</Alert>
	);
}
