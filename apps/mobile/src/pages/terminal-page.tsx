import { useLocalSearchParams } from "expo-router";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { LibraryPage } from "@/components/detail/layout";
import { RouteLoadingSkeleton } from "@/components/route-loading-skeleton";
import { useDashboardAgents } from "@/hooks/use-dashboard-agents";
import { TerminalScreen } from "@/hosted/agents/hosted-terminal-panel";
import { routeParam } from "@/lib/route-params";

export default function TerminalPage() {
	const { id } = useLocalSearchParams<{ id?: string | string[] }>();
	const agentId = routeParam(id);
	const { inventory } = useDashboardAgents();
	const matches = inventory.data?.filter((item) => item.agent_id === agentId);
	if (inventory.isPending)
		return (
			<LibraryPage>
				<RouteLoadingSkeleton />
			</LibraryPage>
		);
	if (inventory.isError || matches?.length !== 1)
		return (
			<LibraryPage>
				<ApiErrorPanel error={inventory.error} onRetry={() => void inventory.refetch()} />
			</LibraryPage>
		);
	return <TerminalScreen deploymentId={matches[0]?.resource.id} />;
}
