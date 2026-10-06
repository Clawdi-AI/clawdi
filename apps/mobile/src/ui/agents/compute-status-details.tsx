import type { DeploymentRead } from "@clawdi/shared/api";
import { computeStatusDetailsClasses as styles } from "@clawdi/shared/ui";
import { computeStatusDetailsPresentation } from "@clawdi/shared/view";
import { WebText, WebView } from "../web-layout";

export function ComputeStatusDetails({ deployment }: { deployment: DeploymentRead }) {
	const state = computeStatusDetailsPresentation(deployment);
	if (!state) return null;
	return (
		<WebView recipe={styles.root} accessibilityRole="alert">
			<WebView recipe={state.tone === "destructive" ? styles.failure : ""}>
				{state.title ? <WebText recipe={styles.failureTitle}>{state.title}</WebText> : null}
				<WebText
					recipe={
						state.tone === "destructive"
							? styles.destructive
							: state.tone === "warning"
								? styles.warning
								: styles.neutral
					}
				>
					{state.description}
				</WebText>
			</WebView>
		</WebView>
	);
}
