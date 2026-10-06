import { useLocalSearchParams } from "expo-router";
import { DeploymentDetailScreen } from "@/hosted/agents/hosted-agent-detail";

export default function DeploymentRoute() {
	const { deploymentId } = useLocalSearchParams<{ deploymentId?: string | string[] }>();
	return (
		<DeploymentDetailScreen
			deploymentId={typeof deploymentId === "string" ? deploymentId : undefined}
		/>
	);
}
