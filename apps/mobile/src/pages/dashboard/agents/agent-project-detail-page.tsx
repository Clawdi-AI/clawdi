import { useLocalSearchParams, useSegments } from "expo-router";
import { AgentResourceRouteGate } from "@/components/dashboard/agent-resource-route-gate";
import { routeParam } from "@/lib/route-params";
import { ProjectDetailScreen } from "@/pages/dashboard/projects/[id]/page";

export default function AgentProjectDetailPage() {
	const params = useLocalSearchParams<{ id?: string | string[]; projectId?: string | string[] }>();
	const segments = useSegments();
	const tab = segments.at(-1);
	return (
		<AgentResourceRouteGate
			agentId={routeParam(params.id)}
			projectId={routeParam(params.projectId)}
		>
			<ProjectDetailScreen initialTab={tab === "skills" || tab === "vaults" ? tab : "overview"} />
		</AgentResourceRouteGate>
	);
}
