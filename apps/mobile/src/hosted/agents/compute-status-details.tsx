import type { DeploymentRead, HostedDeployOperation } from "@clawdi/shared/api";
import { computeStatusDetailsClasses as styles } from "@clawdi/shared/ui";
import { computeStatusDetailsPresentation } from "@clawdi/shared/view";
import { WebText, WebView } from "@/components/ui/web-layout";
import { CancelOperation } from "@/hosted/agents/deployment-cancel-action";

export function ComputeStatusDetails({
	deployment,
	timedOut,
	escalated,
	operation,
	onCancelRequested,
}: {
	deployment: DeploymentRead;
	timedOut: boolean;
	escalated: boolean;
	/** The in-flight operation a stuck change offers to cancel. */
	operation: HostedDeployOperation | null;
	onCancelRequested: () => Promise<void>;
}) {
	const state = computeStatusDetailsPresentation(deployment, { timedOut, escalated });
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
			{state.cancel && operation ? (
				<CancelOperation operation={operation} onRequested={onCancelRequested} />
			) : null}
		</WebView>
	);
}
