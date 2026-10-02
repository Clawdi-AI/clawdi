import { useLocalSearchParams } from "expo-router";
import { DeploymentDetailScreen } from "../../src/features/deployments";

export default function DeploymentRoute() {
	const { deploymentId } = useLocalSearchParams<{ deploymentId?: string | string[] }>();
	return (
		<DeploymentDetailScreen
			deploymentId={typeof deploymentId === "string" ? deploymentId : undefined}
		/>
	);
}
