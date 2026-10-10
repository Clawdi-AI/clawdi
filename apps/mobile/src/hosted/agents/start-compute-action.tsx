import type { DeploymentRead, HostedDeployOperation } from "@clawdi/shared/api";
import { SUPPORT_MAILTO, startComputeActionPresentation } from "@clawdi/shared/view";
import { router } from "expo-router";
import { Linking } from "react-native";
import { ActionButton } from "@/components/dashboard/controls";
import { Text } from "@/components/ui/text";
import { DeploymentControls } from "@/hosted/agents/deployment-controls";
import { AddCreditsAction } from "@/hosted/billing/store/add-credits";
import { agentSectionHref } from "@/lib/agent-routes";
import { useI18n } from "@/lib/i18n";
import { useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";
import { useStoreSurfaces } from "@/platform/store/store-provider";

/**
 * Web StartComputeAction. Store policy: top-ups use Add credits, and card payment recovery stays a
 * status (ComputeDunningBanner) with no action.
 */
export function StartComputeAction({
	deployment,
	startLabel,
	blocked,
	transitioning,
	onAccepted,
	onAbsent,
	onFunded,
}: {
	deployment: DeploymentRead;
	startLabel?: string;
	blocked: boolean;
	transitioning: boolean;
	onAccepted: (operation: HostedDeployOperation) => Promise<void>;
	onAbsent: () => Promise<void>;
	/** Wallet credits changed; refresh the deployment's start action. */
	onFunded: () => void;
}) {
	const t = useI18n();
	const scope = useAccountScope();
	const support = useAuthAction(scope.identity);
	const surfaces = useStoreSurfaces();
	const action = startComputeActionPresentation(deployment, startLabel);
	if (action.target === "start" && action.enabled)
		return (
			<DeploymentControls
				section="startup"
				startLabel={action.label}
				deployment={deployment}
				deploymentId={deployment.resource.id}
				blocked={blocked}
				transitioning={transitioning}
				onAccepted={onAccepted}
				onAbsent={onAbsent}
			/>
		);
	if (action.target === "top_up" && surfaces.addCredits)
		return <AddCreditsAction size="sm" onFunded={onFunded} />;
	if (action.target === "fix_payment" && !surfaces.cardBilling) return null;
	if (action.target === "contact_support")
		return (
			<>
				<ActionButton
					label={action.label}
					disabled={support.busy}
					onPress={() =>
						void support.run(async () => {
							await Linking.openURL(SUPPORT_MAILTO);
						})
					}
				/>
				{support.error ? <Text accessibilityRole="alert">{t("runtime.supportFailed")}</Text> : null}
			</>
		);
	return (
		<ActionButton
			label={action.label}
			disabled={!action.enabled}
			onPress={() => router.push(agentSectionHref(deployment.agent_id ?? "", "settings"))}
		/>
	);
}
