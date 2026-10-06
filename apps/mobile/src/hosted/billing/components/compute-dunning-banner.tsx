import type { DeploymentRead } from "@clawdi/shared/api";
import { computeDunningBannerClasses as styles } from "@clawdi/shared/ui";
import {
	computeDunningCopy,
	computeDunningDescription,
	computeDunningState,
} from "@clawdi/shared/view";
import { router } from "expo-router";
import { Info, TriangleAlert } from "lucide-react-native";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { WebView, webView } from "@/components/ui/web-layout";

export function ComputeDunningBanner({ deployment }: { deployment: DeploymentRead }) {
	const state = computeDunningState(deployment);
	if (!state) return null;
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
				<Text>{computeDunningDescription(state)}</Text>
				{state.secondaryTarget === "transactions" ? (
					<Button variant="outline" size="sm" onPress={() => router.push("/billing/wallet")}>
						<Text>{computeDunningCopy.transactions}</Text>
					</Button>
				) : null}
			</WebView>
		</Alert>
	);
}
