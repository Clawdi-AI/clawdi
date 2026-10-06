import { agentsIndexClasses, connectedAgentDetailClasses as styles } from "@clawdi/shared/ui";
import { agentDisplayName, agentOverviewCopy, agentSurfaceCopy } from "@clawdi/shared/view";
import { useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams } from "expo-router";
import { LayoutDashboard } from "lucide-react-native";
import { useState } from "react";
import { RefreshControl } from "react-native";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { AgentOverview } from "@/components/dashboard/agent-overview-resource-bodies";
import { AgentSectionNavigation } from "@/components/dashboard/navigation";
import { PageHeader, PageHeaderSkeleton } from "@/components/page-header";
import { AppScrollView } from "@/components/ui/primitives";
import { WebIcon, webView } from "@/components/ui/web-layout";
import { useCloudAgent } from "@/hooks/cloud-inventory";
import { useDashboardAgents } from "@/hooks/use-dashboard-agents";
import { DeploymentDetailScreen } from "@/hosted/agents/hosted-agent-detail";
import { routeParam } from "@/lib/route-params";
import { accountQueryKey, useAccountScope } from "@/platform/account-lifecycle";
import { ReadScreen } from "@/platform/safe-area-screen";
export default function AgentDetailRoute() {
	const params = useLocalSearchParams<{ agentId?: string | string[] }>();
	const cache = useQueryClient();
	const scope = useAccountScope();
	const [refreshing, setRefreshing] = useState(false);
	const refresh = async () => {
		setRefreshing(true);
		try {
			await cache.invalidateQueries({ queryKey: accountQueryKey(scope) });
		} finally {
			setRefreshing(false);
		}
	};
	const agentId = routeParam(params.agentId),
		agent = useCloudAgent(agentId);
	const inventory = useDashboardAgents();
	const deployment = inventory.inventory.data?.find((d) => d.agent_id === agentId);
	if (deployment) return <DeploymentDetailScreen deploymentId={deployment.resource.id} />;
	return (
		<ReadScreen>
			<AppScrollView
				contentContainerClassName={webView(agentsIndexClasses.page)}
				refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
			>
				{agentId ? <AgentSectionNavigation agentId={agentId} /> : null}
				{agent.isPending && agentId ? (
					<PageHeaderSkeleton icon />
				) : !agentId || !agent.data ? (
					<ApiErrorPanel
						error={agent.error}
						title={agentSurfaceCopy.couldnTLoadAgent}
						onRetry={() => void agent.refetch()}
					/>
				) : (
					<>
						<PageHeader
							title={agentDisplayName(agent.data)}
							description={agentOverviewCopy.description}
							icon={<WebIcon as={LayoutDashboard} recipe={styles.sectionIcon} />}
						/>
						<AgentOverview agent={agent.data} />
					</>
				)}
			</AppScrollView>
		</ReadScreen>
	);
}
