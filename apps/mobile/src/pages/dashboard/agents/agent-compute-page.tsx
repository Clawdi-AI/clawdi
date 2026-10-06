import { useLocalSearchParams } from "expo-router";
import { useDashboardAgents } from "@/hooks/use-dashboard-agents";
import { DeploymentDetailScreen } from "@/hosted/agents/hosted-agent-detail";
import { routeParam } from "@/lib/route-params";
export default function AgentComputePage() {
	const params = useLocalSearchParams<{ id?: string | string[] }>();
	const id = routeParam(params.id);
	const { inventory } = useDashboardAgents();
	const matches = inventory.data?.filter((item) => item.agent_id === id);
	return (
		<DeploymentDetailScreen
			deploymentId={matches?.length === 1 ? matches[0]?.resource.id : undefined}
			management
		/>
	);
}
