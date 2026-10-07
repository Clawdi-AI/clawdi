import { agentsIndexClasses, connectedAgentDetailClasses as styles } from "@clawdi/shared/ui";
import { agentDisplayName, agentOverviewCopy, agentSurfaceCopy } from "@clawdi/shared/view";
import { useQueryClient } from "@tanstack/react-query";
import { Redirect, useLocalSearchParams } from "expo-router";
import { LayoutDashboard } from "lucide-react-native";
import { useState } from "react";
import { RefreshControl } from "react-native";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { AgentOverview } from "@/components/dashboard/agent-overview-resource-bodies";
import { AgentSectionNavigation } from "@/components/dashboard/navigation";
import { LibraryPage } from "@/components/detail/layout";
import { PageHeader, PageHeaderSkeleton } from "@/components/page-header";
import { RouteLoadingSkeleton } from "@/components/route-loading-skeleton";
import { AppScrollView } from "@/components/ui/view";
import { WebIcon, webView } from "@/components/ui/web-layout";
import { useCloudAgent } from "@/hooks/cloud-inventory";
import { useDashboardAgents } from "@/hooks/use-dashboard-agents";
import { DeploymentDetailScreen } from "@/hosted/agents/hosted-agent-detail";
import { agentSectionHref } from "@/lib/agent-routes";
import { useMobileApi } from "@/lib/api-provider";
import { routeParam } from "@/lib/route-params";
import { accountQueryKey, useAccountScope } from "@/platform/account-lifecycle";
import { SafeAreaScreen } from "@/platform/safe-area-screen";
export default function AgentDetailRoute({ section }: { section?: "console" | "files" } = {}) {
	const params = useLocalSearchParams<{ id?: string | string[] }>();
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
	const agentId = routeParam(params.id),
		agent = useCloudAgent(agentId);
	const inventory = useDashboardAgents();
	const { hosted } = useMobileApi();
	const deployment = inventory.inventory.data?.find((d) => d.agent_id === agentId);
	if (deployment)
		return <DeploymentDetailScreen deploymentId={deployment.resource.id} section={section} />;
	// Files is hosted-only; once the hosted inventory resolves without this Agent, use the overview.
	if (section === "files" && agentId) {
		if (!hosted || !inventory.inventory.isPending)
			return <Redirect href={agentSectionHref(agentId)} />;
		return (
			<LibraryPage>
				<RouteLoadingSkeleton />
			</LibraryPage>
		);
	}
	return (
		<SafeAreaScreen>
			<AppScrollView
				contentContainerClassName={`${webView(agentsIndexClasses.page)} pt-5 pb-6`}
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
							testID={`agent-detail-${agent.data.id}`}
							title={agentDisplayName(agent.data)}
							description={agentOverviewCopy.description}
							icon={<WebIcon as={LayoutDashboard} recipe={styles.sectionIcon} />}
						/>
						<AgentOverview agent={agent.data} />
					</>
				)}
			</AppScrollView>
		</SafeAreaScreen>
	);
}
