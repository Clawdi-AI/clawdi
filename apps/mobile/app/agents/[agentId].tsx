import { agentsIndexClasses, connectedAgentDetailClasses as styles } from "@clawdi/shared/ui";
import { agentDisplayName, agentOverviewCopy, agentSurfaceCopy } from "@clawdi/shared/view";
import { useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams } from "expo-router";
import { LayoutDashboard } from "lucide-react-native";
import { useState } from "react";
import { RefreshControl } from "react-native";
import { AgentOverview } from "../../src/features/agent-overview";
import { useCloudAgent } from "../../src/features/cloud-inventory";
import { routeParam } from "../../src/features/read-helpers";
import { accountQueryKey, useAccountScope } from "../../src/platform/account-lifecycle";
import { AgentSectionNavigation } from "../../src/ui/agents/navigation";
import { ApiErrorPanel } from "../../src/ui/api-error-panel";
import { PageHeader, PageHeaderSkeleton } from "../../src/ui/page-header";
import { AppScrollView } from "../../src/ui/primitives";
import { ReadScreen } from "../../src/ui/read-screen";
import { WebIcon, webView } from "../../src/ui/web-layout";
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
